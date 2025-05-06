# Shopify Reverse Auction App - Installation Guide

This guide will walk you through setting up the Reverse Auction app from start to finish.

## Part 1: Server Setup

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- A Shopify Partner account
- A Shopify development store

### Step 1: Clone and Configure the App

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/shopify-reverse-auction.git
   cd shopify-reverse-auction
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory with the following variables:
   ```
   SHOPIFY_API_KEY=your_api_key
   SHOPIFY_API_SECRET=your_api_secret
   SHOPIFY_ACCESS_TOKEN=your_access_token
   SHOPIFY_SHOP_URL=your-store.myshopify.com
   PORT=3000
   ```

### Step 2: Get Shopify API Credentials

1. Go to your [Shopify Partner Dashboard](https://partners.shopify.com/)
2. Navigate to Apps > Create app
3. Name your app "Reverse Auction"
4. Set the App URL to your server's URL (we'll configure this later)
5. Copy the API key and API secret to your `.env` file

### Step 3: Get a Shopify Access Token

1. In your Shopify admin, go to Apps > Manage private apps
2. Create a new private app
3. Name it "Reverse Auction"
4. Set appropriate permissions:
   - `read_products`, `write_products`
   - `read_price_rules`, `write_price_rules`
5. Copy the access token to your `.env` file
6. Set your shop URL in the `.env` file (e.g., `your-store.myshopify.com`)

### Step 4: Deploy to Render.com

1. Create a [Render.com](https://render.com) account if you don't have one
2. Connect your GitHub repository
3. Create a new Web Service
4. Choose your repository
5. Configure the service:
   - Name: `reverse-auction`
   - Environment: `Node`
   - Build Command: `npm install`
   - Start Command: `node server.js`
6. Add all environment variables from your `.env` file
7. Deploy the service
8. Note your Render.com URL (e.g., `https://reverse-auction.onrender.com`)

## Part 2: Shopify Theme Integration

### Step 1: Add Timer Snippet to Your Theme

1. In your Shopify admin, go to Online Store > Themes
2. Click "Actions" > "Edit code" on your current theme
3. Under Snippets, click "Add a new snippet"
4. Name it `auction-timer.liquid`
5. Copy the contents from `public/snippets/auction-timer.liquid` in this repository
6. Update the `statusUrl` in the script to your Render.com URL:
   ```javascript
   const statusUrl = 'https://your-app-name.onrender.com/api/auction-status';
   ```
7. Save the file

### Step 2: Add Timer to Product Template

1. Still in the theme editor, locate your product template 
   (typically `templates/product.liquid` or in the Sections folder)
2. Add this line where you want the timer to appear:
   ```liquid
   {% render 'auction-timer' %}
   ```
3. Save the file

### Step 3: Test CORS Configuration

1. Open your Shopify store in a browser
2. Navigate to a product page
3. Open the browser's developer tools (F12 or right-click > Inspect)
4. Check the Console tab for any CORS-related errors
5. If you see CORS errors, double-check your server CORS configuration in `server.js`

## Part 3: Running Your First Auction

### Step 1: Set Compare-at Prices

1. Access your admin panel at `https://your-app-name.onrender.com`
2. Click "Set Compare At Price for All Products"
3. This will set the compare-at price equal to the regular price for all products

### Step 2: Start an Auction

1. In the admin panel, set:
   - Interval: How many minutes between price drops (e.g., 5)
   - Reduction Percent: How much to reduce each interval (e.g., 5%)
2. Click "Start Auction for All Products"

### Step 3: Monitor and Verify

1. Visit your store's product pages
2. Verify the timer appears and counts down
3. Check that prices update after each interval
4. Monitor the admin panel to see the auction progress

### Step 4: Stop the Auction (When Needed)

1. In the admin panel, click "Stop Auction for All Products"
2. This will reset all products to their original prices

## Troubleshooting

### Timer Doesn't Appear
- Check the browser console for errors
- Verify the snippet was added correctly to your theme
- Make sure your server URL is correct in the snippet

### Prices Don't Update
- Check your server logs for API errors
- Verify your Shopify access token has the correct permissions
- Check for API rate limit issues

### Server Connection Issues
- Verify your server is running
- Check your .env file for correct credentials
- Verify your Shopify store URL is entered correctly

## Additional Resources

- [Shopify API Documentation](https://shopify.dev/docs/admin-api)
- [Liquid Template Documentation](https://shopify.dev/docs/themes/liquid/reference)
- [Render.com Documentation](https://render.com/docs) 