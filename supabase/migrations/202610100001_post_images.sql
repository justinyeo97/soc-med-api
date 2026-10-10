-- Post images use a private bucket so Storage access follows post visibility.
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS image_path text;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'post-images',
  'post-images',
  false,
  8388608,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY "Users upload images to their own folder"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'post-images'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);

CREATE POLICY "Users delete their own post images"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'post-images'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);

CREATE POLICY "Users read images for visible posts"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'post-images'
  AND EXISTS (
    SELECT 1
    FROM public.posts p
    WHERE p.image_path = storage.objects.name
      AND (
        p.visibility = 'public'
        OR p.author_id = (SELECT auth.uid())
        OR (
          p.visibility = 'friends'
          AND p.author_id IN (
            SELECT followed_id FROM public.friendships WHERE follower_id = (SELECT auth.uid())
            INTERSECT
            SELECT follower_id FROM public.friendships WHERE followed_id = (SELECT auth.uid())
          )
        )
      )
  )
);
