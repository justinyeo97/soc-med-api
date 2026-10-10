require('dotenv').config();
const { Pool } = require("pg");
const express = require("express");
const path = require("path");
const app = express();
const cors = require("cors");
const { supabase, createUserClient } = require("./supabaseClient");
const multer = require('multer');
app.use(express.json());
app.use(cors());
const rateLimit = require('express-rate-limit')

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.',
})
app.use(limiter);

const uploadPostImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'));
    }
    cb(null, true);
  },
}).single('image');
const postImageBucket = process.env.SUPABASE_POST_IMAGES_BUCKET || 'post-images';

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

app.get('/follow', verifySupabaseSession, async (req, res) => {
  const { data, error } = await supabase
    .from('friendships')
    .select('followed_id')
    .eq('follower_id', req.auth.id);

  if (error) return res.status(500).json({ error: error.message });

  return res.json(data);
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

app.post('/posts', verifySupabaseSession, (req, res, next) => {
  uploadPostImage(req, res, (error) => error ? next(error) : next());
}, async (req, res) => {
  const { title, content, visibility } = req.body;
  const author_id = req.user.userId;

  const validVisibilities = ['public', 'friends'];
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Content is required' });
  }
  if (!validVisibilities.includes(visibility)) {
    return res.status(400).json({ error: 'Visibility must be either public or friends' });
  }

  const { data: post, error } = await supabase.from('posts')
    .insert([{ author_id, title: title.trim(), content: content.trim(), visibility }])
    .select('id, author_id, title, content, visibility, created_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  let imagePath = null;
  if (req.file) {
    const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[req.file.mimetype];
    imagePath = `${author_id}/${post.id}.${extension}`;
    const userSupabase = createUserClient(req.headers.authorization.slice(7));
    const { error: uploadError } = await userSupabase.storage.from(postImageBucket).upload(imagePath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });
    if (uploadError) {
      await supabase.from('posts').delete().eq('id', post.id);
      return res.status(400).json({ error: `Image upload failed: ${uploadError.message}` });
    }

    const { error: updateError } = await supabase.from('posts').update({ image_path: imagePath }).eq('id', post.id);
    if (updateError) {
      await userSupabase.storage.from(postImageBucket).remove([imagePath]);
      await supabase.from('posts').delete().eq('id', post.id);
      return res.status(500).json({ error: updateError.message });
    }
  }

  return res.status(201).json({
    message: 'Post created',
    post: { ...post, image_path: imagePath },
  });
});

app.get('/posts', verifySupabaseSession, async (req, res) => {
  const userId = req.user.userId;

  const baseQuery = `
    SELECT p.id, p.author_id, u.username AS author, p.title, p.content, p.visibility, p.image_path, p.created_at
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
    const userSupabase = createUserClient(req.headers.authorization.slice(7));
    const posts = await Promise.all(rows.map(async (post) => {
      if (!post.image_path) return { ...post, image_url: null };
      const { data, error } = await userSupabase.storage.from(postImageBucket)
        .createSignedUrl(post.image_path, 60 * 60);
      if (error) throw error;
      return { ...post, image_url: data.signedUrl };
    }));
    res.json(posts);
  } catch (err) {
    console.error('Error running posts query:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
  }
  if (err.message?.startsWith('Only JPEG')) return res.status(415).json({ error: err.message });
  console.error('Request error:', err);
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(3000, () => {
  console.log("App is listening on port 3000");
});



