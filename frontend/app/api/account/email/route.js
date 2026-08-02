import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ObjectId } from "mongodb";
import { authOptions } from "../../auth/[...nextauth]/route";
import clientPromise from "../../../../lib/mongodb";
import { emailChangeLimiter } from "../../../../lib/rateLimit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const userId = new ObjectId(session.user.id);

  const user = await users.findOne({ _id: userId });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (newEmail === user.email) {
    return NextResponse.json({ success: true, email: user.email, unchanged: true });
  }

  // Credentials accounts must confirm identity with their current password
  // before the login email can change — this is the one field that
  // controls account access, so we don't let a hijacked session alone
  // change it silently.
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

  await users.updateOne(
    { _id: userId },
    { $set: { email: newEmail, updatedAt: new Date() } }
  );

  return NextResponse.json({ success: true, email: newEmail });
}