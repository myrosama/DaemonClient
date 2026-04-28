# DaemonClient Setup Guide

## For New Users

### Prerequisites
- Email address
- Telegram account
- Cloudflare account (free tier)

### Step-by-Step Setup

#### 1. Create Account
1. Go to [accounts.daemonclient.uz](https://accounts.daemonclient.uz)
2. Click "Create Account"
3. Enter email and password
4. Verify email

#### 2. Connect Telegram Storage
1. Choose "Automated Setup" (recommended)
   - Click "Create My Secure Storage"
   - Wait 30-60 seconds
   - Follow bot ownership transfer steps
2. OR "Manual Setup"
   - Create bot via @BotFather
   - Create private channel
   - Add bot as admin
   - Enter credentials

#### 3. Deploy Your Backend
1. Create free Cloudflare account at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
2. Generate API token:
   - Go to Profile → API Tokens
   - Click "Create Token"
   - Permissions needed:
     - Workers Scripts (Edit)
     - D1 Database (Edit)
     - Account Settings (Read)
3. Paste token in setup page
4. Click "Deploy My Backend"
5. Wait 30-45 seconds

#### 4. Start Using DaemonClient Photos
- Your backend is ready!
- Visit [photos.daemonclient.uz](https://photos.daemonclient.uz)
- Upload your first photos
- **Encryption is enabled by default** for maximum security

## Troubleshooting

### Token Validation Fails
- Ensure token has all required permissions
- Check token hasn't expired
- Verify you copied the full token

### Deployment Fails
- Check Cloudflare account is verified
- Ensure you're under free tier limits
- Contact support: support@daemonclient.uz

### Worker Not Responding
- Check Cloudflare dashboard for errors
- Verify D1 database was created
- Check worker logs in Cloudflare

## FAQ

**Q: How much does this cost?**
A: $0. Everything runs on free tiers.

**Q: Where is my data stored?**
A: Photos in YOUR Telegram channel, metadata in YOUR Cloudflare D1 database.

**Q: Can DaemonClient access my photos?**
A: No. Everything is in your own infrastructure.

**Q: Is my data encrypted?**
A: Yes! Encryption is enabled by default. Your photos are encrypted before storing in Telegram.

**Q: How do updates work?**
A: Automatic. We deploy updates to your worker with your stored token.

**Q: Can I revoke access?**
A: Yes. Delete the API token in Cloudflare dashboard anytime.
