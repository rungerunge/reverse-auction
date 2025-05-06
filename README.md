# Shopify Reverse Auction App

A Node.js application that creates a "reverse auction" system for Shopify stores. The app automatically reduces product prices at set intervals.

## Features

- **Set Compare-At Prices**: Bulk set compare-at prices for all products
- **Global Auction**: Run an auction for all products simultaneously with consistent discount percentages
- **Scheduled Price Reductions**: Automatically reduce prices at configurable intervals
- **Rate Limit Handling**: Respects Shopify API rate limits to prevent errors
- **Batch Processing**: Processes products in batches for reliable operation
- **Retry Logic**: Automatically retries failed API calls
- **UI Indicators**: Clear visual indicators of auction status and countdown timers

## Tech Stack

- Node.js
- Express.js
- SQLite
- GraphQL (for Shopify API interactions)
- EJS (for admin views)

## Installation

1. Clone this repository
   ```
   git clone https://github.com/rungerunge/reverse-auction.git
   cd reverse-auction
   ```

2. Install dependencies
   ```
   npm install
   ```

3. Copy the environment variables example file and update with your credentials
   ```
   cp env.example .env
   ```

4. Start the application
   ```
   npm start
   ```

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret
SHOPIFY_ACCESS_TOKEN=your_access_token
SHOPIFY_SHOP_URL=your-store.myshopify.com
PORT=3000
```

## Deployment to Render.com

This app can be easily deployed to Render.com:

1. Push your code to GitHub
2. In Render.com, create a new Web Service
3. Connect your GitHub repository
4. Configure the service:
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Add all environment variables from your .env file

## Adding the Timer to Your Shopify Theme

1. Upload the `auction-timer.liquid` file to your theme's `snippets` folder
2. Upload the `auction-timer-section.liquid` file to your theme's `sections` folder
3. Configure a proxy in your Shopify admin:
   - Go to Apps > App setup > App proxy
   - Set the proxy path to `auction-timer`
   - Set the proxy URL to your Render.com service URL
4. Add the section to your product page in the theme editor

## License

[MIT License](LICENSE) 