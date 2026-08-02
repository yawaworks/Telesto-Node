import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ObjectId } from "mongodb";
import { authOptions } from "../auth/[...nextauth]/route";
import clientPromise from "../../../lib/mongodb";

// Researcher profile fields. Kept separate from the core auth fields
// (email, hashedPassword, etc.) under a `profile` subdocument so we never
// risk touching NextAuth/adapter-managed fields on write.
const EDITABLE_FIELDS = [
  "name",
  "institution",
  "role",
  "orcid",
  "bio",
  "researchFocus", // array of tags, e.g. ["Coral reefs", "Deep-sea fauna"]
  "fieldSites", // array of tags, e.g. ["Coral Triangle", "Gulf of Mexico"]
  "certifications", // array of tags, e.g. ["PADI Rescue Diver", "ROV Pilot Tech II"]
  "contactEmail",
  "scholarUrl",
  "orcidUrl",
  "websiteUrl",
  "alertsOptIn",
];

const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const URL_RE = /^https?:\/\/.+/i;

function sanitizeTagArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v).trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((v) => v.slice(0, 80));
}

function validateAndClean(body) {
  const errors = [];
  const clean = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 120);
    if (!name) errors.push("Name can't be empty");
    clean.name = name;
  }
  if (body.institution !== undefined) clean.institution = String(body.institution).trim().slice(0, 200);
  if (body.role !== undefined) clean.role = String(body.role).trim().slice(0, 120);
  if (body.bio !== undefined) clean.bio = String(body.bio).trim().slice(0, 1000);
  if (body.contactEmail !== undefined) {
    const val = String(body.contactEmail).trim();
    if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      errors.push("Contact email looks invalid");
    } else {
      clean.contactEmail = val;
    }
  }
  if (body.orcid !== undefined) {
    const val = String(body.orcid).trim();
    if (val && !ORCID_RE.test(val)) {
      errors.push("ORCID iD should look like 0000-0002-1825-0097");
    } else {
      clean.orcid = val;
    }
  }
  for (const field of ["scholarUrl", "websiteUrl"]) {
    if (body[field] !== undefined) {
      const val = String(body[field]).trim();
      if (val && !URL_RE.test(val)) {
        errors.push(`${field === "scholarUrl" ? "Scholar/ResearchGate" : "Website"} link should start with http:// or https://`);
      } else {
        clean[field] = val;
      }
    }
  }
  for (const field of ["researchFocus", "fieldSites", "certifications"]) {
    if (body[field] !== undefined) clean[field] = sanitizeTagArray(body[field]);
  }
  if (body.alertsOptIn !== undefined) clean.alertsOptIn = Boolean(body.alertsOptIn);

  return { clean, errors };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const client = await clientPromise;
  const users = client.db().collection("users");
  const user = await users.findOne(
    { _id: new ObjectId(session.user.id) },
    { projection: { hashedPassword: 0 } }
  );

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const profile = user.profile || {};
  return NextResponse.json({
    email: user.email,
    hasPassword: Boolean(user.hashedPassword),
    name: profile.name || user.name || "",
    institution: profile.institution || "",
    role: profile.role || "",
    orcid: profile.orcid || "",
    bio: profile.bio || "",
    researchFocus: profile.researchFocus || [],
    fieldSites: profile.fieldSites || [],
    certifications: profile.certifications || [],
    contactEmail: profile.contactEmail || "",
    scholarUrl: profile.scholarUrl || "",
    websiteUrl: profile.websiteUrl || "",
    alertsOptIn: profile.alertsOptIn ?? true,
    memberSince: user.createdAt || null,
  });
}

export async function PATCH(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const submitted = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in body) submitted[field] = body[field];
  }

  const { clean, errors } = validateAndClean(submitted);
  if (errors.length > 0) {
    return NextResponse.json({ error: errors[0], errors }, { status: 400 });
  }

  const client = await clientPromise;
  const users = client.db().collection("users");

  const setDoc = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(clean)) {
    if (key === "name") {
      // Keep top-level `name` (used elsewhere, e.g. session/header) in sync
      // with profile.name so existing code paths don't need to change.
      setDoc.name = value;
      setDoc["profile.name"] = value;
    } else {
      setDoc[`profile.${key}`] = value;
    }
  }

  await users.updateOne({ _id: new ObjectId(session.user.id) }, { $set: setDoc });

  return NextResponse.json({ success: true });
}