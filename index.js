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

// Root and static page endpoint
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Shared authentication and run helpers
async function verifySupabaseSession(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return res.status(401).json({ error: 'A Supabase access token is required' });
  }

  // OAuth providers (including Google) return a Supabase session. Verify its
  // access token with Supabase Auth rather than trusting client-supplied claims.
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) return res.status(401).end();

  // OAuth sign-ins do not pass through /auth/signup, so create the app profile
  // on first authenticated API request. Preserve profiles created earlier.
  try {
    const name = data.user.user_metadata?.full_name
      || data.user.user_metadata?.name
      || data.user.user_metadata?.user_name
      || data.user.email?.split('@')[0]
      || 'user';
    const baseUsername = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'user';
    const username = `${baseUsername}_${data.user.id.replace(/-/g, '').slice(0, 8)}`;
    await pool.query(
      'INSERT INTO public.users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [data.user.id, username],
    );
  } catch (err) {
    console.error('Error creating authenticated user profile:', err);
    return res.status(500).json({ error: 'Could not initialize user profile' });
  }

  req.auth = { id: data.user.id };
  req.user = {
    userId: data.user.id,
    email: data.user.email,
    role: data.user.app_metadata?.role || "user",
    provider: data.user.app_metadata?.provider || 'email',
  };

  return next();
}

function parseRunInput(input) {
  if (input === undefined || input === null || input === '') return null;
  let run = input;
  if (typeof run === 'string') {
    try {
      run = JSON.parse(run);
    } catch {
      throw new Error('run must be a JSON object');
    }
  }
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new Error('run must be an object');
  }

  const startedAt = new Date(run.started_at);
  const distanceM = Number(run.distance_m);
  const elapsedSeconds = Number(run.elapsed_seconds);
  const movingSeconds = run.moving_seconds === undefined || run.moving_seconds === null || run.moving_seconds === ''
    ? null : Number(run.moving_seconds);
  const elevationGainM = run.elevation_gain_m === undefined || run.elevation_gain_m === null || run.elevation_gain_m === ''
    ? null : Number(run.elevation_gain_m);
  const averageHeartRate = run.average_heart_rate === undefined || run.average_heart_rate === null || run.average_heart_rate === ''
    ? null : Number(run.average_heart_rate);
  const maxHeartRate = run.max_heart_rate === undefined || run.max_heart_rate === null || run.max_heart_rate === ''
    ? null : Number(run.max_heart_rate);

  if (!run.started_at || Number.isNaN(startedAt.getTime())) throw new Error('run.started_at must be a valid date');
  if (!Number.isInteger(distanceM) || distanceM <= 0) throw new Error('run.distance_m must be a positive integer');
  if (!Number.isInteger(elapsedSeconds) || elapsedSeconds <= 0) throw new Error('run.elapsed_seconds must be a positive integer');
  if (movingSeconds !== null && (!Number.isInteger(movingSeconds) || movingSeconds < 0 || movingSeconds > elapsedSeconds)) {
    throw new Error('run.moving_seconds must be an integer between 0 and elapsed_seconds');
  }
  if (elevationGainM !== null && (!Number.isFinite(elevationGainM) || elevationGainM < 0)) {
    throw new Error('run.elevation_gain_m must be a non-negative number');
  }
  for (const [name, value] of [['average_heart_rate', averageHeartRate], ['max_heart_rate', maxHeartRate]]) {
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 250)) {
      throw new Error(`run.${name} must be an integer between 1 and 250`);
    }
  }
  if (averageHeartRate !== null && maxHeartRate !== null && maxHeartRate < averageHeartRate) {
    throw new Error('run.max_heart_rate cannot be lower than average_heart_rate');
  }

  const source = run.source === undefined || run.source === '' ? 'manual' : run.source;
  if (typeof source !== 'string' || source.length > 50) throw new Error('run.source must be a string of at most 50 characters');
  if (run.external_id !== undefined && run.external_id !== null && typeof run.external_id !== 'string') {
    throw new Error('run.external_id must be a string');
  }
  if (run.title !== undefined && run.title !== null && typeof run.title !== 'string') {
    throw new Error('run.title must be a string');
  }

  return {
    title: run.title?.trim() || null,
    startedAt: startedAt.toISOString(),
    distanceM,
    elapsedSeconds,
    movingSeconds,
    elevationGainM,
    averageHeartRate,
    maxHeartRate,
    source,
    externalId: run.external_id || null,
  };
}

async function insertRun({ userId, postId = null, visibility, run }) {
  const { rows } = await pool.query(
    `INSERT INTO public.runs (
       user_id, post_id, title, started_at, distance_m, elapsed_seconds,
       moving_seconds, elevation_gain_m, average_heart_rate, max_heart_rate,
       source, external_id, visibility
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [userId, postId, run.title, run.startedAt, run.distanceM, run.elapsedSeconds,
      run.movingSeconds, run.elevationGainM, run.averageHeartRate, run.maxHeartRate,
      run.source, run.externalId, visibility],
  );
  return rows[0];
}

// Authentication endpoints
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

app.get("/whoami", verifySupabaseSession, (req, res) => {
  res.json({
    userId: req.user.userId,
    email: req.user.email,
    role: req.user.role,
    provider: req.user.provider,
  });
})


// Social endpoints
app.post('/follow', verifySupabaseSession, async (req, res) => {
  const userSupabase = createUserClient(req.headers.authorization.slice(7));
  const follower_id = req.auth.id;
  const { followed_id } = req.body;

  if (typeof followed_id !== 'string' || !followed_id) {
    return res.status(400).json({ error: 'followed_id is required' });
  }

  if (followed_id === follower_id) {
    return res.status(400).json({ error: 'You cannot follow yourself' });
  }

  const { data: followed, error: userError } = await userSupabase
    .from('users')
    .select('id')
    .eq('id', followed_id)
    .maybeSingle();

  if (userError) return res.status(500).json({ error: userError.message });
  if (!followed) return res.status(404).json({ error: 'User not found' });

  const { data: existing, error: followCheckError } = await userSupabase
    .from('friendships')
    .select('follower_id')
    .eq('follower_id', follower_id)
    .eq('followed_id', followed_id)
    .maybeSingle();

  if (followCheckError) return res.status(500).json({ error: followCheckError.message });
  if (existing) return res.status(409).json({ error: 'Already following this user' });

  const { error: insertError } = await userSupabase
    .from('friendships')
    .insert({ follower_id, followed_id });

  if (insertError) return res.status(500).json({ error: insertError.message });

  return res.status(201).json({ message: 'Followed successfully' });
});

app.get('/follow', verifySupabaseSession, async (req, res) => {
  const userSupabase = createUserClient(req.headers.authorization.slice(7));
  const { data, error } = await userSupabase
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

// Run endpoints
app.post('/runs', verifySupabaseSession, async (req, res) => {
  let run;
  try {
    run = parseRunInput(req.body.run ?? req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (!run) return res.status(400).json({ error: 'Run information is required' });

  const requestedVisibility = req.body.visibility;
  if (requestedVisibility !== undefined && !['public', 'friends', 'private'].includes(requestedVisibility)) {
    return res.status(400).json({ error: 'Visibility must be public, friends, or private' });
  }

  const rawPostId = req.body.post_id;
  let postId = null;
  let visibility = requestedVisibility || 'private';
  if (rawPostId !== undefined && rawPostId !== null && rawPostId !== '') {
    postId = Number(rawPostId);
    if (!Number.isSafeInteger(postId) || postId <= 0) {
      return res.status(400).json({ error: 'post_id must be a positive integer' });
    }
    try {
      const { rows } = await pool.query(
        'SELECT author_id, visibility FROM public.posts WHERE id = $1',
        [postId],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Post not found' });
      if (rows[0].author_id !== req.user.userId) return res.status(403).json({ error: 'You can only attach a run to your own post' });
      visibility = rows[0].visibility;
    } catch (error) {
      console.error('Error checking post for run:', error);
      return res.status(500).json({ error: 'Could not validate post' });
    }
  }

  try {
    const runRecord = await insertRun({ userId: req.user.userId, postId, visibility, run });
    return res.status(201).json({ run: runRecord });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'This run is already recorded or attached to another run post' });
    console.error('Error creating run:', error);
    return res.status(500).json({ error: 'Could not create run' });
  }
});

app.get('/runs', verifySupabaseSession, async (req, res) => {
  const userId = req.user.userId;
  try {
    const { rows } = await pool.query(
      `SELECT r.*, u.username
       FROM public.runs r
       LEFT JOIN public.users u ON u.id = r.user_id
       WHERE r.visibility = 'public'
          OR r.user_id = $1
          OR (
            r.visibility = 'friends'
            AND r.user_id IN (
              SELECT followed_id FROM public.friendships WHERE follower_id = $1
              INTERSECT
              SELECT follower_id FROM public.friendships WHERE followed_id = $1
            )
          )
       ORDER BY r.started_at DESC, r.id DESC`,
      [userId],
    );
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching runs:', error);
    return res.status(500).json({ error: 'Could not fetch runs' });
  }
});


// Post endpoints
app.post('/posts', verifySupabaseSession, (req, res, next) => {
  uploadPostImage(req, res, (error) => error ? next(error) : next());
}, async (req, res) => {
  const { title, content, visibility } = req.body;
  const author_id = req.user.userId;
  let runInput;

  try {
    runInput = parseRunInput(req.body.run);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

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

  const userSupabase = createUserClient(req.headers.authorization.slice(7));
  const { data: post, error } = await userSupabase.from('posts')
    .insert([{ author_id, title: title.trim(), content: content.trim(), visibility }])
    .select('id, author_id, title, content, visibility, created_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  let runRecord = null;
  if (runInput) {
    try {
      runRecord = await insertRun({ userId: author_id, postId: post.id, visibility, run: runInput });
    } catch (runError) {
      await userSupabase.from('posts').delete().eq('id', post.id);
      if (runError.code === '23505') return res.status(409).json({ error: 'This run is already recorded' });
      console.error('Error saving post run:', runError);
      return res.status(500).json({ error: 'Could not save run information' });
    }
  }

  let imagePath = null;
  if (req.file) {
    const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[req.file.mimetype];
    imagePath = `${author_id}/${post.id}.${extension}`;
    const { error: uploadError } = await userSupabase.storage.from(postImageBucket).upload(imagePath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });
    if (uploadError) {
      if (runRecord) await pool.query('DELETE FROM public.runs WHERE id = $1 AND user_id = $2', [runRecord.id, author_id]);
      await userSupabase.from('posts').delete().eq('id', post.id);
      return res.status(400).json({ error: `Image upload failed: ${uploadError.message}` });
    }

    const { error: updateError } = await userSupabase.from('posts').update({ image_path: imagePath }).eq('id', post.id);
    if (updateError) {
      await userSupabase.storage.from(postImageBucket).remove([imagePath]);
      if (runRecord) await pool.query('DELETE FROM public.runs WHERE id = $1 AND user_id = $2', [runRecord.id, author_id]);
      await userSupabase.from('posts').delete().eq('id', post.id);
      return res.status(500).json({ error: updateError.message });
    }
  }

  return res.status(201).json({
    message: 'Post created',
    post: { ...post, image_path: imagePath, run: runRecord },
  });
});

app.get('/posts', verifySupabaseSession, async (req, res) => {
  const userId = req.user.userId;

  const baseQuery = `
    SELECT p.id, p.author_id, u.username AS author, p.title, p.content, p.visibility, p.image_path, p.created_at,
      CASE WHEN r.id IS NULL OR NOT (
        r.visibility = 'public'
        OR r.user_id = $1
        OR (
          r.visibility = 'friends'
          AND r.user_id IN (
            SELECT followed_id FROM public.friendships WHERE follower_id = $1
            INTERSECT
            SELECT follower_id FROM public.friendships WHERE followed_id = $1
          )
        )
      ) THEN NULL ELSE jsonb_build_object(
        'id', r.id,
        'title', r.title,
        'started_at', r.started_at,
        'distance_m', r.distance_m,
        'elapsed_seconds', r.elapsed_seconds,
        'moving_seconds', r.moving_seconds,
        'elevation_gain_m', r.elevation_gain_m,
        'average_heart_rate', r.average_heart_rate,
        'max_heart_rate', r.max_heart_rate,
        'source', r.source
      ) END AS run
    FROM posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN public.runs r ON r.post_id = p.id
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

// Error handling and server startup
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



