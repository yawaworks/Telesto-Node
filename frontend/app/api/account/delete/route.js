import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ObjectId } from "mongodb";
import { authOptions } from "../../auth/[...nextauth]/route";
import clientPromise from "../../../../lib/mongodb";
import { verifyTotpToken, findMatchingBackupCodeIndex } from "../../../../lib/twoFactor";
import { emailChangeLimiter } from "../../../../lib/rateLimit";
import { sendEmail } from "../../../../lib/mailer";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session?.user?.email) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { success } = await emailChangeLimiter.limit(session.user.id);
  if (!success) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const currentPassword = body?.currentPassword;
  const totpCode = body?.totpCode;
  const confirmationText = body?.confirmationText;

  if (confirmationText !== "DELETE") {
    return NextResponse.json(
      { error: 'Type "DELETE" to confirm — this can\'t be undone' },
      { status: 400 }
    );
  }

  const client = await clientPromise;
  const users = client.db().collection("users");
  const userId = new ObjectId(session.user.id);
  const user = await users.findOne({ _id: userId });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Identity re-confirmation before permanent deletion — same principle
  // as email-change and 2FA-disable: an active session alone isn't
  // enough proof for an irreversible action like this.
  if (user.hashedPassword) {
    if (!currentPassword) {
      return NextResponse.json(
        { error: "Enter your current password to delete your account" },
        { status: 400 }
      );
    }
    const passwordValid = await bcrypt.compare(currentPassword, user.hashedPassword);
    if (!passwordValid) {
      return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
    }
  }
  // Google-only accounts (no hashedPassword) skip this — there's no local
  // credential to check, and the user is already authenticated via Google.

  if (user.twoFactorEnabled) {
    if (!totpCode) {
      return NextResponse.json(
        { error: "Enter your 2FA code to delete your account" },
        { status: 400 }
      );
    }
    let totpValid = verifyTotpToken(user.twoFactorSecret, totpCode);
    if (!totpValid && Array.isArray(user.twoFactorBackupCodes)) {
      const idx = await findMatchingBackupCodeIndex(totpCode, user.twoFactorBackupCodes);
      totpValid = idx !== -1;
    }
    if (!totpValid) {
      return NextResponse.json({ error: "That 2FA code doesn't match" }, { status: 401 });
    }
  }

  const email = user.email;
  const deletionErrors = [];

  // Cascade: delete every clip and snapshot this user owns, via the
  // backend's existing ownership-checked DELETE endpoints — reusing the
  // same deletion path a user clicking "delete" in the library UI would
  // trigger, rather than reaching into Mongo/Cloudinary directly from
  // here. Each item's own delete failure is logged but doesn't block the
  // rest — a stray leftover clip is a much smaller problem than an
  // account deletion that partially fails and leaves the user stuck.
  try {
    const clipsRes = await fetch(
      `${API_BASE_URL}/clips?scope=mine&owner_email=${encodeURIComponent(email)}`
    );
    if (clipsRes.ok) {
      const clips = await clipsRes.json();
      for (const clip of clips) {
        try {
          await fetch(
            `${API_BASE_URL}/clips/${clip.id}?owner_email=${encodeURIComponent(email)}`,
            { method: "DELETE" }
          );
        } catch (err) {
          deletionErrors.push(`clip ${clip.id}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error("Failed to fetch clips for deletion cascade:", err);
  }

  try {
    const snapshotsRes = await fetch(
      `${API_BASE_URL}/snapshots?scope=mine&owner_email=${encodeURIComponent(email)}`
    );
    if (snapshotsRes.ok) {
      const snapshots = await snapshotsRes.json();
      for (const snap of snapshots) {
        try {
          await fetch(
            `${API_BASE_URL}/snapshots/${snap.id}?owner_email=${encodeURIComponent(email)}`,
            { method: "DELETE" }
          );
        } catch (err) {
          deletionErrors.push(`snapshot ${snap.id}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error("Failed to fetch snapshots for deletion cascade:", err);
  }

  if (deletionErrors.length > 0) {
    console.error("[account-delete] Some media failed to delete:", deletionErrors);
  }

  // Clean up any pending tokens tied to this account before removing the
  // user doc itself.
  await client.db().collection("emailChangeTokens").deleteMany({ userId });
  await client.db().collection("passwordResetTokens").deleteMany({ userId });

  await users.deleteOne({ _id: userId });

  try {
    await sendEmail({
      to: email,
      subject: "Your Telesto Node account has been deleted",
      html: `
        <p>Your Telesto Node account and associated data (clips, snapshots, profile) have been permanently deleted.</p>
        <p>If you didn't request this, contact support immediately.</p>
      `,
    });
  } catch (err) {
    console.error("Failed to send account-deletion confirmation email:", err);
  }

  return NextResponse.json({
    deleted: true,
    // Surfaced (not just logged) so the user knows if cleanup was
    // incomplete, even though their account itself is gone either way.
    mediaCleanupIssues: deletionErrors.length,
  });
}