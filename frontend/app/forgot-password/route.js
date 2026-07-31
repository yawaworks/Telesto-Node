import crypto from "crypto";
import { NextResponse } from "next/server";
import clientPromise from "../../../lib/mongodb";
import { sendEmail } from "../../../lib/mailer";
import { forgotPasswordLimiter, getClientIp } from "../../../lib/rateLimit";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function POST(request) {
  const ip = getClientIp(request);
  const { success } = await forgotPasswordLimiter.limit(ip);
  if (!success) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }

  const { email: rawEmail } = await request.json();
  if (!rawEmail) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  const email = rawEmail.trim().toLowerCase();

  const client = await clientPromise;
  const users = client.db().collection("users");
  const resetTokens = client.db().collection("passwordResetTokens");
  const user = await users.findOne({ email });

  const genericResponse = NextResponse.json({
    message: "If an account with that email exists, a reset link has been sent.",
  });

  if (!user || !user.hashedPassword) {
    return genericResponse;
  }

  // Clear any previous unused tokens for this user so only the newest
  // link works (avoids multiple valid links floating around).
  await resetTokens.deleteMany({ userId: user._id });

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await resetTokens.insertOne({
    userId: user._id,
    email,
    tokenHash,
    expiresAt,
    createdAt: new Date(),
  });

  const resetUrl = `${process.env.NEXTAUTH_URL}/reset-password?token=${rawToken}&email=${encodeURIComponent(email)}`;

  try {
    await sendEmail({
      to: email,
      subject: "Reset your Telesto Node password",
      html: `
        <p>Someone requested a password reset for your Telesto Node account.</p>
        <p><a href="${resetUrl}">Click here to reset your password</a>. This link expires in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });
  } catch (err) {
    console.error("Failed to send reset email:", err);
  }

  return genericResponse;
}