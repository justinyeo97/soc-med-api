# Velocity Run API

This API powers the Velocity running club app. It lets members create an account, connect with other runners, share posts, and save and view runs.

## Using the API

Authenticated endpoints require a Supabase access token. Include it with each request like this:

```http
Authorization: Bearer <access-token>
```

The sign-in endpoint returns a session containing the access token. Sign-in with Google is handled by Supabase on the frontend; use that session's access token when calling protected API endpoints.

## Endpoints

| Method and path | Sign-in required? | What it does |
| --- | --- | --- |
| `GET /` | No | Opens the API's homepage. |
| `POST /auth/signup` | No | Creates an account using a username, email, and password. |
| `POST /auth/login` | No | Signs in with email and password and returns a session. |
| `GET /whoami` | Yes | Returns the signed-in member's ID, email, role, and sign-in provider. |
| `POST /follow` | Yes | Follows another member using their `followed_id`. You can't follow yourself or follow the same member twice. |
| `GET /follow` | Yes | Lists the IDs of members you follow. |
| `GET /friends` | Yes | Lists your mutual connections: members you follow who also follow you. |
| `POST /posts` | Yes | Shares a post. Title, content, and visibility are required; a run and image can also be included. |
| `GET /posts` | Yes | Shows public posts and posts shared with your mutual connections. Includes run details when visible and an image URL when a post has an image. |
| `POST /runs` | Yes | Saves a run, optionally attaching it to one of your posts. Runs saved separately are private by default. |
| `GET /runs` | Yes | Lists public runs, your own runs, and runs shared with your mutual connections. |

## Creating a post

Send `POST /posts` as `multipart/form-data` when including an image. The required text fields are:

- `title`: the post heading
- `content`: the post text
- `visibility`: `public` or `friends`

Optional fields:

- `image`: one JPEG, PNG, WebP, or GIF image up to 8 MB
- `run`: run details as a JSON object or JSON string

## Recording a run

`POST /runs` accepts a JSON request. The run needs `started_at`, `distance_m`, and `elapsed_seconds`. Other run details, such as moving time, elevation gain, heart rate, title, and source, can also be supplied. Visibility can be `public`, `friends`, or `private`. Provide `post_id` to attach the run to one of your posts.

When a run is included with a post, its visibility follows the post. Run details are included in post results only when the requesting member is allowed to see that run.

## Visibility and connections

- **Public** content can be viewed by signed-in members.
- **Friends** content can be viewed by mutual connections.
- **Private** runs can only be viewed by their owner.

The API currently limits each IP address to 100 requests per minute. Requests above that limit receive a `429 Too Many Requests` response.
