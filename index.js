require("dotenv").config();

const express = require("express");
const cron = require("node-cron");
const supabase = require("./supabase");

const {
  getAuthUrl,
  handleOAuthCallback,
  scanGmailAndSave
} = require("./gmail");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Finance email parser backend is running"
  });
});

app.get("/auth/google", (req, res) => {
  res.redirect(getAuthUrl());
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send("Missing OAuth code");
    }

    const tokens = await handleOAuthCallback(code);

    console.log("OAuth tokens:", tokens);

    res.send(`
      <h2>Google OAuth successful</h2>
      <p>Copy this refresh token into your .env:</p>
      <pre>${tokens.refresh_token || "No refresh token returned. Try revoking app access and login again."}</pre>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send("OAuth failed");
  }
});

function requireCronSecret(req, res, next) {
  const secret = req.headers["x-cron-secret"];

  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

app.post("/parse-now", requireCronSecret, async (req, res) => {
  try {
    const results = await scanGmailAndSave();
    res.json({ ok: true, results });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/transactions", async (req, res) => {
  const { data, error } = await supabase
    .from("transactions")
    .select("*, categories(*)")
    .order("transaction_datetime", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

app.get("/transactions/unassigned", async (req, res) => {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .is("category_id", null)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

app.patch("/transactions/:id/category", async (req, res) => {
  const { category_id } = req.body;

  const { data, error } = await supabase
    .from("transactions")
    .update({
      category_id,
      status: category_id ? "categorised" : "unassigned"
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

app.get("/categories", async (req, res) => {
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .order("name", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

app.get("/transactions/summary", async (req, res) => {
  const month = req.query.month; // example: 2026-06

  if (!month) {
    return res.status(400).json({
      error: "Missing month. Use /transactions/summary?month=2026-06"
    });
  }

  const startDate = `${month}-01T00:00:00.000Z`;
  const endDate = new Date(startDate);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, category_id, categories(name, color, icon)")
    .gte("transaction_datetime", startDate)
    .lt("transaction_datetime", endDate.toISOString())
    .eq("direction", "outflow");

  if (error) return res.status(500).json({ error: error.message });

  const summary = {};

  for (const tx of data) {
    const categoryName = tx.categories?.name || "Unassigned";

    if (!summary[categoryName]) {
      summary[categoryName] = {
        category: categoryName,
        color: tx.categories?.color || "#9CA3AF",
        icon: tx.categories?.icon || "circle",
        total: 0
      };
    }

    summary[categoryName].total += Number(tx.amount);
  }

  res.json(Object.values(summary));
});

app.post("/register-push-token", async (req, res) => {
  const { expo_push_token, device_name } = req.body;

  const { data, error } = await supabase
    .from("push_tokens")
    .upsert(
      {
        expo_push_token,
        device_name,
        last_used_at: new Date().toISOString()
      },
      { onConflict: "expo_push_token" }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

if (process.env.ENABLE_CRON === "true") {
  cron.schedule("*/5 * * * *", async () => {
    console.log("Running scheduled Gmail scan...");
    try {
      const results = await scanGmailAndSave();
      console.log(results);
    } catch (error) {
      console.error("Cron scan failed:", error.message);
    }
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});