import crypto from "crypto";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ObjectId } from "mongodb";
import { authOptions } from "../../auth/[...nextauth]/route";
import clientPromise from "../../../../lib/mongodb";
import { sendEmail } from "../../../../lib/mailer";
import { emailChangeLimiter } from "../../../../lib/rateLimit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHANGE_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function PATCH(request) {
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

  const newEmail = String(body?.newEmail || "").trim().toLowerCase();
  const currentPassword = body?.currentPassword;

  if (!newEmail || !EMAIL_RE.test(newEmail)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const client = await clientPromise;
  const users = client.db().collection("users");
  const changeTokens = client.db().collection("emailChangeTokens");
  const userId = new ObjectId(session.user.id);

  const user = await users.findOne({ _id: userId });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (newEmail === user.email) {
    return NextResponse.json({ error: "That's already your current email" }, { status: 400 });
  }

  // Credentials accounts must confirm identity with their current password
  // before a change can even be requested — this is the one field that
  // controls account access, so we don't let a hijacked session alone
  // change it.
  if (user.hashedPassword) {
    if (!currentPassword) {
      return NextResponse.json(
        { error: "Enter your current password to change your email" },
        { status: 400 }
      );
    }
    const isValid = await bcrypt.compare(currentPassword, user.hashedPassword);
    if (!isValid) {
      return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
    }
  }
  // Google-only accounts (no hashedPassword) skip the password check —
  // there's no local credential to verify, and the user is already
  // authenticated via their Google session.

  const existing = await users.findOne({ email: newEmail, _id: { $ne: userId } });
  if (existing) {
    return NextResponse.json(
      { error: "That email is already in use by another account" },
      { status: 409 }
    );
  }

  // Only the newest pending request for this user should be valid.
  await changeTokens.deleteMany({ userId });

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + CHANGE_TOKEN_TTL_MS);

  await changeTokens.insertOne({
    userId,
    oldEmail: user.email,
    newEmail,
    tokenHash,
    expiresAt,
    createdAt: new Date(),
  });

  const confirmUrl = `${process.env.NEXTAUTH_URL}/api/account/email/confirm?token=${rawToken}`;

  // The confirmation link goes to the NEW address — that's the whole
  // point, it proves the person requesting the change actually controls
  // it. Nothing changes in the database until they click it.
  try {
    await sendEmail({
      to: newEmail,
      subject: "Confirm your new Telesto Node email",
      html: `
        <p>Someone requested to change the login email on a Telesto Node account from ${user.email} to this address.</p>
        <p><a href="${confirmUrl}">Click here to confirm this email change</a>. This link expires in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email — no change will be made.</p>
      `,
    });
  } catch (err) {
    console.error("Failed to send email-change confirmation:", err);
    return NextResponse.json(
      { error: "Couldn't send confirmation email — try again shortly" },
      { status: 502 }
    );
  }

  // A heads-up to the OLD address too, so the account owner notices if
  // they didn't request this themselves.
  try {
    await sendEmail({
      to: user.email,
      subject: "Email change requested on your Telesto Node account",
      html: `
        <p>A request was made to change your Telesto Node login email to ${newEmail}.</p>
        <p>If this was you, no action is needed — check the new inbox to confirm it.</p>
        <p>If this wasn't you, your password may be compromised. Consider resetting it.</p>
      `,
    });
  } catch (err) {
    console.error("Failed to send email-change heads-up to old address:", err);
    // Not fatal — the confirmation email to the new address already went out.
  }

  return NextResponse.json({
    pending: true,
    message: `Confirmation link sent to ${newEmail}. Nothing changes until it's confirmed.`,
  });
}