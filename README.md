# 🚀 Quick Start Guide

Get your file sharing app running in 3 minutes!

## Option 1: Local Development (Fastest)

```bash
# 1. Navigate to the project
cd sharedrop-app

# 2. Install dependencies
npm install

# 3. Start the server
npm start

# 4. Open in browser
# Visit: http://localhost:3000
```

That's it! Open the same URL on multiple devices to start sharing files.

## Option 2: Production Deployment

### Using Railway (Easiest - Free Tier Available)

1. Go to [railway.app](https://railway.app)
2. Click "Start a New Project"
3. Select "Deploy from GitHub repo"
4. Connect your repository
5. Railway will auto-detect and deploy
6. Get your public URL and share!

### Using Render (Also Easy - Free Tier)

1. Go to [render.com](https://render.com)
2. Click "New +" → "Web Service"
3. Connect your repository
4. Settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Click "Create Web Service"
6. Done!

### Using Heroku

```bash
# Install Heroku CLI, then:
heroku login
heroku create your-app-name
git push heroku main
heroku open
```

## Testing Locally

### Test with Two Browser Windows
1. Open http://localhost:3000 in Chrome
2. Open http://localhost:3000 in another Chrome window (or incognito)
3. You'll see both devices appear
4. Click on a device, select files, and watch them transfer!

### Test with Two Devices on Same Network
1. Find your local IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
2. Start server: `npm start`
3. On device 1: Open http://YOUR-IP:3000
4. On device 2: Open http://YOUR-IP:3000
5. Devices will discover each other automatically

## Common Issues & Solutions

### "Cannot find module 'express'"
```bash
npm install
```

### Port 3000 already in use
```bash
# Use different port
PORT=3001 npm start
```

### Devices not discovering each other
- Make sure both are connected to the signaling server (green status dot)
- Check that you're accessing the same server URL
- Verify firewall isn't blocking connections

### File transfer not working
- Ensure HTTPS is enabled (required for WebRTC in production)
- Check browser console for errors
- Try refreshing both pages

## Next Steps

1. ⭐ **Customize the design** - Edit colors in `public/index.html`
2. 🔒 **Add HTTPS** - Use Let's Encrypt or deploy to Render/Railway
3. 🌐 **Configure TURN** - For better connectivity across networks (see README.md)
4. 📱 **Share the link** - Send to friends and start sharing!

## Need Help?

Check the full README.md for:
- Detailed deployment instructions
- TURN server configuration
- Security best practices
- API documentation
- Troubleshooting guide

---

**Pro Tip**: For the best experience, deploy to a service with HTTPS (like Railway or Render) so you can share files from anywhere!
