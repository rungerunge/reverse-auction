# Shopify Reverse Auction App

A Shopify application that automatically reduces product prices at set intervals, creating urgency and incentive for customers to purchase.

## Features

- **Global Auction System**: Apply discounts to all products simultaneously
- **Configurable Parameters**: Set custom intervals and discount percentages
- **Live Countdown Timer**: Show customers when the next price drop will occur
- **Automatic Price Management**: System handles all price changes
- **GraphQL API**: Efficient API usage with batch processing
- **Rate Limit Handling**: Built-in retry logic for API failures
- **Timezone-Based Scheduling**: Schedule auctions to start at specific times in CET timezone
- **Standalone Timer Section**: Display countdown timers without server connection

## Setup Instructions

### Server Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file based on `env.example` with your Shopify credentials:
   ```
   SHOPIFY_API_KEY=your_api_key
   SHOPIFY_API_SECRET=your_api_secret
   SHOPIFY_ACCESS_TOKEN=your_access_token
   SHOPIFY_SHOP_URL=your-store.myshopify.com
   ```
4. Start the server:
   ```
   npm start
   ```
5. Deploy to a hosting service like Render.com

### Shopify Store Setup

1. **Add Timer to Product Template**:
   - Go to Online Store > Themes > Actions > Edit code
   - Navigate to your product template file (e.g., `templates/product.liquid`)
   - Add this line where you want the timer to appear:
     ```liquid
     {% render 'auction-timer' %}
     ```

2. **Add Timer Snippet**:
   - Create a new snippet called `auction-timer.liquid`
   - Copy the contents from `public/snippets/auction-timer.liquid`
   - Update the `statusUrl` in the script to point to your deployed server
   
3. **Alternative: Use Standalone Timer Section**:
   - Copy `public/sections/auction-timer-section.liquid` to your theme's sections folder
   - Add the section through the theme customizer
   - Configure the discount percentage and end time directly in the theme editor
   
4. **Set Compare-at Prices**:
   - Use the admin interface to set compare-at prices for all products
   - This establishes the original price before discounts

## Usage

1. **Start an Auction**:
   - Go to the app admin panel
   - Set the interval (minutes between price drops)
   - Set the reduction percent (how much to reduce each interval)
   - Optionally, check "Schedule start time" and set a future start time in CET timezone
   - Click "Start Auction for All Products"

2. **Monitor Progress**:
   - The admin panel shows current discount and countdown
   - Products will update automatically at each interval

3. **Stop an Auction**:
   - Click "Stop Auction for All Products" 
   - All prices will revert to original values

## Timezone Features

The app supports two different timezone approaches:

1. **Server-Based Timer**: The auction-timer.liquid snippet connects to the server API and displays the current auction status and countdown. The server manages the auction timing and automatically updates prices at each interval.

2. **Standalone Timer**: The auction-timer-section.liquid section works without a server connection. It displays a countdown based on a CET timezone end date specified in the theme editor. This doesn't change prices automatically but provides a visual countdown for your customers.

## Troubleshooting

- **Timer Not Showing**: Check browser console for CORS errors
- **Prices Not Updating**: Check server logs for API rate limit issues
- **Server Connection Issues**: Verify your Shopify credentials are correct
- **Timezone Issues**: Use the test-timer.html page to verify your server and browser timezone settings

## License

MIT 