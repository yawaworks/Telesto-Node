import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ObjectId } from "mongodb";
import { authOptions } from "../../../auth/[...nextauth]/route";
import clientPromise from "../../../../../lib/mongodb";
import { verifyTotpToken, generateBackupCodes } from "../../../../../lib/twoFactor";
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

  const code = body?.code;
  if (!code) {
    return NextResponse.json({ error: "Enter the 6-digit code from your authenticator app" }, { status: 400 });
  }

  const client = await clientPromise;
  const users = client.db().collection("users");
  const userId = new ObjectId(session.user.id);
  const user = await users.findOne({ _id: userId });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (!user.pendingTwoFactorSecret) {
    return NextResponse.json(
      { error: "No pending 2FA setup found — start setup again" },
      { status: 400 }
    );
  }

  const isValid = verifyTotpToken(user.pendingTwoFactorSecret, code);
  if (!isValid) {
    return NextResponse.json({ error: "That code doesn't match — check your app and try again" }, { status: 400 });
  }

  const { plainCodes, hashedCodes } = await generateBackupCodes();

  await users.updateOne(
    { _id: userId },
    {
      $set: {
        twoFactorSecret: user.pendingTwoFactorSecret,
        twoFactorEnabled: true,
        twoFactorBackupCodes: hashedCodes,
        twoFactorEnabledAt: new Date(),
      },
      $unset: { pendingTwoFactorSecret: "", pendingTwoFactorSecretCreatedAt: "" },
    }
  );

  // A security-relevant change to the account — worth a heads-up email,
  // same principle as the email-change notification.
  try {
    await sendEmail({
      to: user.email,
      subject: "Two-factor authentication enabled on your Telesto Node account",
      html: `
        <p>Two-factor authentication was just turned on for your account.</p>
        <p>If this wasn't you, someone else may have access to your account — change your password immediately.</p>
      `,
    });
  } catch (err) {
    console.error("Failed to send 2FA-enabled notification:", err);
  }

  return NextResponse.json({
    enabled: true,
    backupCodes: plainCodes, // shown exactly once — not retrievable again after this response
  });
}