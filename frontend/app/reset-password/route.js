import crypto from "crypto";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import clientPromise from "../../../lib/mongodb";

export async function POST(request) {
  const { email: rawEmail, token, password } = await request.json();

  if (!rawEmail || !token || !password) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const email = rawEmail.trim().toLowerCase();
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const client = await clientPromise;
  const users = client.db().collection("users");
  const resetTokens = client.db().collection("passwordResetTokens");

  const tokenDoc = await resetTokens.findOne({
    email,
    tokenHash,
    expiresAt: { $gt: new Date() },
  });

  if (!tokenDoc) {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired. Request a new one." },
      { status: 400 }
    );
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  await users.updateOne({ _id: tokenDoc.userId }, { $set: { hashedPassword } });

  // Single-use: delete immediately after success.
  await resetTokens.deleteOne({ _id: tokenDoc._id });

  return NextResponse.json({ success: true });
}