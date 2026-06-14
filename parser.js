function getLineValue(text, label) {
  const labels = [
    "Transaction Ref",
    "Date & Time",
    "Amount",
    "From",
    "To"
  ];

  const stopPhrases = [
    "If unauthorised",
    "If unauthorized",
    "To view transaction",
    "To view your transactions",
    "Please call DBS hotline",
    "Thank you for banking with us",
    "Yours faithfully",
    "This is an auto-generated message"
  ];

  const stops = [...labels, ...stopPhrases]
    .filter((l) => l !== label)
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  const regex = new RegExp(
    `${label}:\\s*([\\s\\S]*?)(?=\\s+(?:${stops})(?::|\\b)|$)`,
    "i"
  );

  const match = text.match(regex);
  return match ? match[1].replace(/\s+/g, " ").trim() : null;
}

function parseDBSDateTime(value) {
  if (!value) return null;

  // Example: 05 Jun 01:14 (SGT)
  const cleaned = value.replace(/\(SGT\)/i, "").trim();

  const currentYear = new Date().getFullYear();
  const fullDateString = `${cleaned} ${currentYear} GMT+0800`;

  const date = new Date(fullDateString);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function getSenderEmail(headers = []) {
  const fromHeader =
    headers.find((h) => h.name.toLowerCase() === "from")?.value || "";

  const emailMatch = fromHeader.match(/<(.+?)>/);

  if (emailMatch) return emailMatch[1].toLowerCase();

  return fromHeader.trim().toLowerCase();
}

function shouldAcceptSubject(subject) {
  const allowedSubjects = [
    "digibank Alert - Successful NETS Scan & Pay",
    "iBanking Alerts",
    "Transaction Alerts"
  ];

  const blockedSubjects = [
    "digibank Alerts - You've received a transfer"
  ];

  if (blockedSubjects.some((s) => subject.includes(s))) {
    return false;
  }

  return allowedSubjects.some((s) => subject.includes(s));
}

function parseTransactionEmail({ subject, body, headers }) {
  const text = `${subject}\n${body}`;
  const senderEmail = getSenderEmail(headers);

  if (!shouldAcceptSubject(subject)) {
    return {
      shouldInsert: false,
      reason: "subject_not_allowed"
    };
  }

  const transactionRef = getLineValue(text, "Transaction Ref");
  const dateTimeRaw = getLineValue(text, "Date & Time");
  let amountRaw = getLineValue(text, "Amount");
  
  if (!amountRaw) {
        const fallbackAmount = text.match(/Amount\s*:\s*(SGD\s?[0-9,]+(?:\.[0-9]{1,2})?)/i);
        amountRaw = fallbackAmount ? fallbackAmount[1] : null;
}
  const fromAccount = getLineValue(text, "From");
  const toAccount = getLineValue(text, "To");

  if (!amountRaw) {
    return {
      shouldInsert: false,
      reason: "amount_not_found"
    };
  }

  const amountMatch = amountRaw.match(/([A-Z]{3})\s?([0-9,]+(?:\.[0-9]{1,2})?)/i);

  if (!amountMatch) {
    return {
      shouldInsert: false,
      reason: "amount_format_invalid"
    };
  }

  const currency = amountMatch[1].toUpperCase();
  const amount = Number(amountMatch[2].replace(/,/g, ""));

  const ownAccountPattern = /A\/C ending 1070/i;

  // Incoming transfer to yourself — ignore.
  if (toAccount && ownAccountPattern.test(toAccount)) {
    return {
      shouldInsert: false,
      reason: "incoming_to_own_account"
    };
  }

  // DBS/POSB account or PayLah wallet as From means you paid.
  const isOutflow =
    fromAccount &&
    (
      /POSB Passbook Savings Account/i.test(fromAccount) ||
      /PayLah! Wallet/i.test(fromAccount)
    );

  if (!isOutflow) {
    return {
      shouldInsert: false,
      reason: "not_outflow"
    };
  }

  let bankSource = "dbs";

  if (senderEmail.includes("paylah.alert@dbs.com")) {
    bankSource = "paylah";
  }

  if (senderEmail.includes("ibanking.alert@dbs.com")) {
    bankSource = "ibanking";
  }

  return {
    shouldInsert: true,
    transaction: {
      transaction_ref: transactionRef,
      amount,
      currency,
      transaction_datetime: parseDBSDateTime(dateTimeRaw),
      merchant: toAccount,
      description: subject,
      sender_email: senderEmail,
      bank_source: bankSource,
      from_account: fromAccount,
      to_account: toAccount,
      direction: "outflow"
    }
  };
}

module.exports = { parseTransactionEmail };