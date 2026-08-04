import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ObjectId } from "mongodb";
import { authOptions } from "../../../auth/[...nextauth]/route";
import clientPromise from "../../../../../lib/mongodb";
import { verifyTotpToken, findMatchingBackupCodeIndex } from "../../../../../lib/twoFactor";
import { emailChangeLimiter } from "../../../../../lib/rateLimit";
import { sendEmail } from "../../../../../lib/mailer";

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
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

  const client = await clientPromise;
  const users = client.db().collection("users");
  const userId = new ObjectId(session.user.id);
  const user = await users.findOne({ _id: userId });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (!user.twoFactorEnabled) {
    return NextResponse.json({ error: "Two-factor authentication isn't enabled" }, { status: 400 });
  }

  // Require EITHER the account password OR a valid 2FA code (TOTP or
  // backup code) to disable — turning off 2FA is exactly the kind of
  // action an attacker who's stolen a session cookie (but not the
  // password or authenticator) would want to do, so it needs its own
  // proof of identity, not just "you're currently logged in."
  let verified = false;

  if (currentPassword && user.hashedPassword) {
    verified = await bcrypt.compare(currentPassword, user.hashedPassword);
  }
  if (!verified && totpCode) {
    verified = verifyTotpToken(user.twoFactorSecret, totpCode);
  }
  if (!verified && totpCode && Array.isArray(user.twoFactorBackupCodes)) {
    const idx = await findMatchingBackupCodeIndex(totpCode, user.twoFactorBackupCodes);
    verified = idx !== -1;
  }

  if (!verified) {
    return NextResponse.json(
      { error: "Enter your password or a valid 2FA code to disable two-factor authentication" },
      { status: 401 }
    );
  }

  await users.updateOne(
    { _id: userId },
    {
      $set: { twoFactorEnabled: false },
      $unset: { twoFactorSecret: "", twoFactorBackupCodes: "", twoFactorEnabledAt: "" },
    }
  );

  try {
    await sendEmail({
      to: user.email,
      subject: "Two-factor authentication disabled on your Telesto Node account",
      html: `
        <p>Two-factor authentication was just turned off for your account.</p>
        <p>If this wasn't you, your password (or an authenticator device) may be compromised — reset your password immediately.</p>
      `,
    });
  } catch (err) {
    console.error("Failed to send 2FA-disabled notification:", err);
  }

  return NextResponse.json({ disabled: true });
}