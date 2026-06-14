const { google } = require("googleapis");
const supabase = require("./supabase");
const { parseTransactionEmail } = require("./parser");

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  if (process.env.GOOGLE_REFRESH_TOKEN) {
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });
  }

  return oauth2Client;
}

function getAuthUrl() {
  const oauth2Client = getOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });
}

async function handleOAuthCallback(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  return tokens;
}
function decodeBase64Url(data) {
  if (!data) return "";

  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");

  return Buffer.from(normalized, "base64").toString("utf8");
}

function stripHtml(html) {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/tr>/gi, "\n")
        .replace(/<\/td>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16))
        )
        .replace(/&#(\d+);/g, (_, num) =>
            String.fromCharCode(parseInt(num, 10))
        )
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s+/g, "\n")
        .trim();
}

function extractPlainText(payload) {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }

  if (payload.parts) {
    const plainPart = payload.parts.find((part) => part.mimeType === "text/plain");
    if (plainPart) return extractPlainText(plainPart);

    const htmlPart = payload.parts.find((part) => part.mimeType === "text/html");
    if (htmlPart) return extractPlainText(htmlPart);

    return payload.parts.map((part) => extractPlainText(part)).join("\n");
  }

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  return "";
}

async function scanGmailAndSave() {
  const oauth2Client = getOAuthClient();
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const query =
    process.env.SCAN_QUERY ||
    `from:${process.env.BANK_EMAIL_FROM} newer_than:7d`;

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 20
  });

  const messages = listRes.data.messages || [];
  const results = [];

  for (const msg of messages) {
    const gmailMessageId = msg.id;

    const { data: existing } = await supabase
      .from("transactions")
      .select("id")
      .eq("gmail_message_id", gmailMessageId)
      .maybeSingle();

    if (existing) {
      results.push({ gmailMessageId, status: "duplicate_skipped" });
      continue;
    }

    const fullMsg = await gmail.users.messages.get({
      userId: "me",
      id: gmailMessageId,
      format: "full"
    });

    const snippet = fullMsg.data.snippet || "";

    const headers = fullMsg.data.payload.headers || [];
    const subject =
      headers.find((h) => h.name.toLowerCase() === "subject")?.value || "";

    const body = extractPlainText(fullMsg.data.payload) || fullMsg.data.snippet || "";
    console.log("SUBJECT:", subject);
    console.log("BODY PREVIEW:", body.slice(0, 1000));

    const parsed = parseTransactionEmail({
      subject,
      body,
      headers
    });

    if (!parsed.shouldInsert) {
        results.push({
            gmailMessageId,
            status: "skipped",
            reason: parsed.reason,
            subject,
            snippet
        });
        continue;
    }

    const { data, error } = await supabase
        .from("transactions")
        .insert({
            gmail_message_id: gmailMessageId,
            amount: parsed.transaction.amount,
            currency: parsed.transaction.currency,
            transaction_datetime: parsed.transaction.transaction_datetime,
            merchant: parsed.transaction.merchant,
            description: parsed.transaction.description,
            raw_subject: subject,
            raw_body_snippet: snippet,
            transaction_ref: parsed.transaction.transaction_ref,
            sender_email: parsed.transaction.sender_email,
            bank_source: parsed.transaction.bank_source,
            from_account: parsed.transaction.from_account,
            to_account: parsed.transaction.to_account,
            direction: parsed.transaction.direction,
            status: "unassigned"
        })
        .select()
        .single();

    if (error) {
      results.push({
        gmailMessageId,
        status: "insert_failed",
        error: error.message
      });
    } else {
      results.push({
        gmailMessageId,
        status: "inserted",
        transaction: data
      });
    }
  }

  return results;
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  scanGmailAndSave
};