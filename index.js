require('dotenv').config();
const { Pool } = require("pg");
const express = require("express");
const path = require("path");
const app = express();
const cors = require("cors");
const { supabase } = require("./supabaseClient");
app.use(express.json());
app.use(cors());
const rateLimit = require('express-rate-limit')

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.',
})
app.use(limiter);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/auth/signup", async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: "Username, email, and password are required" });
  }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    if (error.message.includes("already registered")) {
      return res.status(409).json({ error: "Email already in use" });
    }
    return res.status(400).json({ error: error.message });
  }

  if (!data.user) {
    return res.status(400).json({ error: "Signup did not return a user" });
  }

  // The profile table has an id foreign key to auth.users and a username column.
  const { error: dbError } = await supabase
    .from("users")
    .insert({ id: data.user.id, username });

  if (dbError) {
    console.error("DB Insert error:", dbError);
    return res.status(500).json({ error: dbError.message });
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

  req.auth = { id: data.user.id };
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


app.post('/follow', verifySupabaseSession, async (req, res) => {
  const follower_id = req.auth.id;
  const { followed_id } = req.body;

  if (typeof followed_id !== 'string' || !followed_id) {
    return res.status(400).json({ error: 'followed_id is required' });
  }

  if (followed_id === follower_id) {
    return res.status(400).json({ error: 'You cannot follow yourself' });
  }

  const { data: followed, error: userError } = await supabase
    .from('users')
    .select('id')
    .eq('id', followed_id)
    .maybeSingle();

  if (userError) return res.status(500).json({ error: userError.message });
  if (!followed) return res.status(404).json({ error: 'User not found' });

  const { data: existing, error: followCheckError } = await supabase
    .from('friendships')
    .select('follower_id')
    .eq('follower_id', follower_id)
    .eq('followed_id', followed_id)
    .maybeSingle();

  if (followCheckError) return res.status(500).json({ error: followCheckError.message });
  if (existing) return res.status(409).json({ error: 'Already following this user' });

  const { error: insertError } = await supabase
    .from('friendships')
    .insert({ follower_id, followed_id });

  if (insertError) return res.status(500).json({ error: insertError.message });

  return res.status(201).json({ message: 'Followed successfully' });
});


app.get('/friends', verifySupabaseSession, async (req, res) => {
  const userId = req.user.userId;

  const query = `
    SELECT u.id, u.username, a.email
    FROM users u
    JOIN auth.users a ON a.id = u.id
    WHERE u.id IN (  
    SELECT followed_id FROM friendships WHERE follower_id = $1
    INTERSECT
    SELECT follower_id FROM friendships WHERE followed_id = $1
  )
  ORDER BY u.username
  `;

  try {
    const { rows } = await pool.query(query, [userId]);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching friends:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/posts', verifySupabaseSession, async (req, res) => {
  const { title, content, visibility } = req.body;
  const author_id = req.user.userId;

  const validVisibilities = ['public', 'friends'];
  const postVisibility = validVisibilities.includes(visibility) ? visibility : 'public';

  if (!content) {
    return res.status(400).json({ error: 'Content is required' });
  }

  const { error } = await supabase.from('posts').insert([{ author_id, title, content, visibility: postVisibility }]);
  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({ message: 'Post created', visibility: postVisibility });
});

app.get('/posts', verifySupabaseSession, async (req, res) => {
  const userId = req.user.userId;

  const baseQuery = `
    SELECT p.id, p.author_id, u.username AS author, p.title, p.content, p.visibility, p.created_at
    FROM posts p
    JOIN users u ON u.id = p.author_id
  `;

  const whereClause = `
  WHERE 
    p.visibility = 'public'
    OR (
      p.visibility = 'friends'
      AND (
        p.author_id = $1
        OR p.author_id IN (
          SELECT followed_id FROM friendships WHERE follower_id = $1
          INTERSECT
          SELECT follower_id FROM friendships WHERE followed_id = $1
        )
      )
    )
`;

  const finalQuery = `${baseQuery} ${whereClause} ORDER BY p.created_at DESC`;

  try {
    const { rows } = await pool.query(finalQuery, [userId]);
    res.json(rows);
  } catch (err) {
    console.error('Error running posts query:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(3000, () => {
  console.log("App is listening on port 3000");
});



