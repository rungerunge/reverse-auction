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

## Components

The app consists of two main components:

1. **Server-Side Application**: Manages auctions and automatically updates product prices via the Shopify API
2. **Standalone Timer Sections**: Client-side timers that can be added to your theme without requiring server connection

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

There are three ways to add a reverse auction timer to your Shopify store:

#### Option 1: Server-Connected Timer Snippet

1. Go to Online Store > Themes > Actions > Edit code
2. Create a new snippet called `auction-timer.liquid`
3. Copy the contents from `public/snippets/auction-timer.liquid`
4. Update the `statusUrl` in the script to point to your deployed server
5. Add this line to your product template where you want the timer to appear:
   ```liquid
   {% render 'auction-timer' %}
   ```

#### Option 2: Original Standalone Timer Section

1. Copy `public/sections/auction-timer-section.liquid` to your theme's sections folder
2. Add the section through the theme customizer
3. Configure settings directly in the theme editor

#### Option 3: Improved Reverse Auction Timer Section (Recommended)

1. Copy `public/sections/reverse-auction-timer.liquid` to your theme's sections folder
2. Add the section through the theme customizer
3. Configure the timer with these advanced options:
   - Start date/time for the auction
   - Starting discount percentage
   - Interval between discounts (in minutes)
   - Discount increment per interval
   - Maximum discount percentage
   - Complete visual customization (colors, fonts, etc.)

For detailed installation instructions for the standalone timer, see the [Reverse Auction Timer Installation Guide](public/REVERSE_AUCTION_TIMER_INSTALLATION.md).

### Testing the Timer

Before adding the timer to your live theme, you can test it using:

1. Open `public/reverse-auction-timer-test.html` in your browser
2. Configure different timer settings and see how they work
3. Use this to determine the best configuration for your store

## Usage

### Server-Side Auction Management

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

### Standalone Timer Usage

The standalone timers work without server connection and don't actually change product prices. They:

1. Calculate discounts based on elapsed time since a configured start date
2. Show countdown to the next price drop
3. Display current and upcoming discount percentages
4. Work independently in the customer's browser

## Comparison of Timer Options

| Feature | Server Timer | Original Standalone | Reverse Auction Timer |
|---------|-------------|---------------------|------------------------|
| Requires Server | Yes | No | No |
| Auto-Updates Prices | Yes | No | No |
| Timezone Support | CET | Limited | Yes |
| Visual Customization | Limited | Moderate | Extensive |
| Schedule Start Time | Yes | No | Yes |
| Next Discount Preview | Yes | Yes | Yes |
| Mobile Responsive | Yes | Yes | Yes |

## Troubleshooting

- **Timer Not Showing**: Check browser console for CORS errors
- **Prices Not Updating**: Check server logs for API rate limit issues
- **Server Connection Issues**: Verify your Shopify credentials are correct
- **Timezone Issues**: Use the included test pages to verify your server and browser timezone settings

## License

MIT 