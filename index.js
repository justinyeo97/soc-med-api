require('dotenv').config();
const { Pool } = require("pg");
const express = require("express");
const path = require("path");
const app = express();
const cors = require("cors");
const { supabase } = require("./supabaseClient");
app.use(express.json());
app.use(cors());



app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/auth/signup", async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    if (error.message.includes("already registered")) {
      return res.status(409).json({ error: "Email already in use" });
    }
    return res.status(400).json({ error: error.message });
  }
  res.status(201).json({ user: data.user });
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(401).json({ error: error.message });
  }
  res.json({ session: data.session });
});

async function verifySupabaseSession(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).end();

  const token = auth.split(" ")[1];
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) return res.status(401).end();

  req.user = {
    userId: data.user.id,
    email: data.user.email,
    role: data.user.app_metadata?.role || "user",
  };

  next();
}

app.get("/whoami", verifySupabaseSession, (req, res) => {
  res.json({
    userId: req.user.userId,
    email: req.user.email,
    role: req.user.role,
  });
})


app.listen(3000, () => {
  console.log("App is listening on port 3000");
});
