import crypto from "crypto";
import { NextResponse } from "next/server";
import clientPromise from "../../../../../lib/mongodb";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rawToken = searchParams.get("token");
  const baseUrl = process.env.NEXTAUTH_URL || new URL(request.url).origin;

  function redirect(status, reason) {
    const url = new URL("/profile", baseUrl);
    url.searchParams.set("emailChange", status);
    if (reason) url.searchParams.set("reason", reason);
    return NextResponse.redirect(url);
  }

  if (!rawToken) {
    return redirect("error", "missing_token");
  }

  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const client = await clientPromise;
  const users = client.db().collection("users");
  const changeTokens = client.db().collection("emailChangeTokens");

  const tokenDoc = await changeTokens.findOne({ tokenHash });
  if (!tokenDoc) {
    return redirect("error", "invalid_token");
  }
  if (tokenDoc.expiresAt < new Date()) {
    await changeTokens.deleteOne({ _id: tokenDoc._id });
    return redirect("error", "expired");
  }

  // Re-check uniqueness at confirmation time too, in case someone else
  // claimed the address while this link was sitting unconfirmed.
  const existing = await users.findOne({
    email: tokenDoc.newEmail,
    _id: { $ne: tokenDoc.userId },
  });
  if (existing) {
    await changeTokens.deleteOne({ _id: tokenDoc._id });
    return redirect("error", "email_taken");
  }

  await users.updateOne(
    { _id: tokenDoc.userId },
    { $set: { email: tokenDoc.newEmail, updatedAt: new Date() } }
  );
  await changeTokens.deleteOne({ _id: tokenDoc._id });

  return redirect("success");
}