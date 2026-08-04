import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ObjectId } from "mongodb";
import QRCode from "qrcode";
import { authOptions } from "../../../auth/[...nextauth]/route";
import clientPromise from "../../../../../lib/mongodb";
import { generateTwoFactorSecret } from "../../../../../lib/twoFactor";
import { emailChangeLimiter } from "../../../../../lib/rateLimit"; // reused: same "sensitive account action" rate profile

export async function POST() {
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

  const client = await clientPromise;
  const users = client.db().collection("users");
  const userId = new ObjectId(session.user.id);
  const user = await users.findOne({ _id: userId });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (user.twoFactorEnabled) {
    return NextResponse.json({ error: "Two-factor authentication is already enabled" }, { status: 400 });
  }

  // Generates a NEW pending secret every time this is called (not yet
  // active) — the user has to prove they can generate a valid code from
  // it via /verify before it becomes their real twoFactorSecret. This
  // means starting setup twice in a row just discards the first attempt,
  // which is fine and expected.
  const { secret, otpauthUrl } = generateTwoFactorSecret(user.email);

  await users.updateOne(
    { _id: userId },
    { $set: { pendingTwoFactorSecret: secret, pendingTwoFactorSecretCreatedAt: new Date() } }
  );

  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  return NextResponse.json({
    secret, // shown as manual-entry fallback for users who can't scan
    qrCodeDataUrl,
  });
}