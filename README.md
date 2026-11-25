# Module 03: Cloud Services & Web App Deployment

I deployed a small notes web app on AWS and explored the main cloud services along the way.

**Live website:** http://3.104.38.98

## What I made

- A **Node.js notes app** (add and delete notes) that stores notes in a PostgreSQL database.
- It runs on an **EC2** server, with **Nginx** in front and **PM2** keeping it running.
- The database is **Amazon RDS (PostgreSQL)**, kept private.

**Flow:** Code → EC2 → RDS → Nginx → Live website

## Cloud services I used

- **EC2:** Ubuntu server that runs the app.
- **S3:** a private bucket; I shared a file with a temporary pre-signed URL.
- **RDS:** managed PostgreSQL database, not public.
- **VPC / security groups:** `web-sg` (SSH from my IP only, HTTP/HTTPS open) and `db-sg` (database port only from `web-sg`).
- **IAM:** a role on the EC2 instance with read access to one S3 bucket and one parameter path, so no access keys are needed in code.
- **CloudWatch:** an alarm that sends me an email when CPU goes above 70%.

## Secrets, logging and quotas

- **Environment variables:** settings are loaded from a `.env` file (not pushed to GitHub). `.env.example` shows the names.
- **Secrets:** the database password is stored in AWS Parameter Store as a SecureString, and the app reads it at startup.
- **Logging:** the app writes JSON logs, and PM2 stores them (`pm2 logs webapp`).
- **Quotas and cost:** I checked Service Quotas and set up an AWS Budget alert.

## How I deployed it

1. Created the security groups, EC2 instance, RDS database, S3 bucket, IAM role and CloudWatch alarm.
2. Stored the database password in Parameter Store.
3. Installed Node.js on the server, cloned this repo, and ran `npm install` in the `app` folder.
4. Created the `.env` file on the server and started the app with PM2.
5. Set up Nginx to forward port 80 to the app on port 3000 (`config/nginx.conf`).

To update the app: push to GitHub, then run `git pull` and `pm2 restart webapp` on the server.

## Repository

```
app/server.js        the web app
config/nginx.conf    Nginx config
config/iam-policy.json   S3 read-only policy
docs/screenshots/    screenshots of each step
.env.example         example settings (no real values)
```

## Security

- Database has no public access, only the web server can reach it.
- SSH is allowed only from my IP.
- No access keys in code; the app uses an IAM role.
- Password is in Parameter Store, and `.env` and `.pem` files are in `.gitignore`.

The site uses HTTP only. A real site would add HTTPS with a domain.
