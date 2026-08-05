const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

async function handle(res) {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      // Response wasn't JSON — fall back to statusText.
    }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

function jsonPost(path, body) {
  return fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(handle);
}

// --- Channels ---------------------------------------------------------

export async function listChannels(memberEmail) {
  const params = new URLSearchParams({ member_email: memberEmail });
  return fetch(`${API_BASE_URL}/channels?${params}`).then(handle);
}

export async function createChannel({ name, type = "project", memberEmails = [], createdBy }) {
  return jsonPost("/channels", {
    name,
    type,
    member_emails: memberEmails,
    created_by: createdBy,
  });
}

export async function addChannelMember(channelId, { email, addedBy }) {
  return jsonPost(`/channels/${channelId}/members`, { email, added_by: addedBy });
}

export async function removeChannelMember(channelId, { email, requestedBy }) {
  const params = new URLSearchParams({ requested_by: requestedBy });
  return fetch(`${API_BASE_URL}/channels/${channelId}/members/${encodeURIComponent(email)}?${params}`, {
    method: "DELETE",
  }).then(handle);
}

export async function promoteChannelAdmin(channelId, { email, requestedBy }) {
  return jsonPost(`/channels/${channelId}/admins`, { email, requested_by: requestedBy });
}

export async function demoteChannelAdmin(channelId, { email, requestedBy }) {
  const params = new URLSearchParams({ requested_by: requestedBy });
  return fetch(`${API_BASE_URL}/channels/${channelId}/admins/${encodeURIComponent(email)}?${params}`, {
    method: "DELETE",
  }).then(handle);
}

export async function markChannelRead(channelId, email) {
  return jsonPost(`/channels/${channelId}/read`, { email });
}

// --- Messages -----------------------------------------------------------

export async function listMessages(channelId, { requesterEmail, since, limit = 200 }) {
  const params = new URLSearchParams({ requester_email: requesterEmail, limit: String(limit) });
  if (since) params.set("since", since);
  return fetch(`${API_BASE_URL}/channels/${channelId}/messages?${params}`).then(handle);
}

export async function postMessage(channelId, { senderEmail, text = "", attachments = [], replyTo = null }) {
  return jsonPost(`/channels/${channelId}/messages`, {
    sender_email: senderEmail,
    text,
    attachments,
    reply_to: replyTo,
  });
}

export async function deleteMessage(messageId, requestedBy) {
  const params = new URLSearchParams({ requested_by: requestedBy });
  return fetch(`${API_BASE_URL}/messages/${messageId}?${params}`, { method: "DELETE" }).then(handle);
}

export async function pinMessage(messageId, requestedBy) {
  const params = new URLSearchParams({ requested_by: requestedBy });
  return fetch(`${API_BASE_URL}/messages/${messageId}/pin?${params}`, { method: "POST" }).then(handle);
}

export async function unpinMessage(messageId, requestedBy) {
  const params = new URLSearchParams({ requested_by: requestedBy });
  return fetch(`${API_BASE_URL}/messages/${messageId}/unpin?${params}`, { method: "POST" }).then(handle);
}

export async function listPinnedMessages(channelId, requesterEmail) {
  const params = new URLSearchParams({ requester_email: requesterEmail });
  return fetch(`${API_BASE_URL}/channels/${channelId}/pinned-messages?${params}`).then(handle);
}

export async function forwardMessage(messageId, { targetChannelId, forwardedBy }) {
  return jsonPost(`/messages/${messageId}/forward`, {
    target_channel_id: targetChannelId,
    forwarded_by: forwardedBy,
  });
}

export async function reportMessage(messageId, { reportedBy, reason = "" }) {
  return jsonPost(`/messages/${messageId}/report`, { reported_by: reportedBy, reason });
}

export async function listChannelReports(channelId, requesterEmail) {
  const params = new URLSearchParams({ requester_email: requesterEmail });
  return fetch(`${API_BASE_URL}/channels/${channelId}/reports?${params}`).then(handle);
}

export async function resolveReport(reportId, { requestedBy, action = "dismiss" }) {
  const params = new URLSearchParams({ requested_by: requestedBy, action });
  return fetch(`${API_BASE_URL}/reports/${reportId}/resolve?${params}`, { method: "POST" }).then(handle);
}

// --- Attachments (files + voice messages) --------------------------------

export async function uploadChannelAttachment(channelId, { file, uploaderEmail, kind = "file" }) {
  const form = new FormData();
  form.append("file", file);
  form.append("uploader_email", uploaderEmail);
  form.append("kind", kind);
  const res = await fetch(`${API_BASE_URL}/channels/${channelId}/attachments`, {
    method: "POST",
    body: form,
  });
  return handle(res);
}

// --- Presence -------------------------------------------------------------

export async function sendHeartbeat(email) {
  return jsonPost("/presence/heartbeat", { email });
}

export async function setPresenceStatus(email, status) {
  return jsonPost("/presence/status", { email, status });
}

export async function getPresence(emails) {
  if (!emails.length) return [];
  const params = new URLSearchParams({ emails: emails.join(",") });
  return fetch(`${API_BASE_URL}/presence?${params}`).then(handle);
}

// --- Calls & Meetings (meet.jit.si — free, no account, no metering) -----

export async function getCallRoom(channelId, requesterEmail) {
  const params = new URLSearchParams({ requester_email: requesterEmail });
  return fetch(`${API_BASE_URL}/channels/${channelId}/call-room?${params}`).then(handle);
}

export async function createMeeting(channelId, { title, scheduledAt, durationMinutes = 30, createdBy, attendeeEmails = [] }) {
  return jsonPost(`/channels/${channelId}/meetings`, {
    title,
    scheduled_at: scheduledAt,
    duration_minutes: durationMinutes,
    created_by: createdBy,
    attendee_emails: attendeeEmails,
  });
}

export async function listMeetings(channelId, requesterEmail) {
  const params = new URLSearchParams({ requester_email: requesterEmail });
  return fetch(`${API_BASE_URL}/channels/${channelId}/meetings?${params}`).then(handle);
}

export async function cancelMeeting(meetingId, requestedBy) {
  const params = new URLSearchParams({ requested_by: requestedBy });
  return fetch(`${API_BASE_URL}/meetings/${meetingId}?${params}`, { method: "DELETE" }).then(handle);
}

export function meetingIcsUrl(meetingId, requesterEmail) {
  const params = new URLSearchParams({ requester_email: requesterEmail });
  return `${API_BASE_URL}/meetings/${meetingId}/ics?${params}`;
}