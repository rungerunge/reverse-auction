# Reverse Auction Timer - Installation Guide

This guide explains how to add the Reverse Auction Timer section to your Shopify theme.

## What is the Reverse Auction Timer?

The Reverse Auction Timer is a standalone section that creates a "reverse auction" effect on your store:

- It shows a countdown timer until the next price drop
- The discount percentage automatically increases at set intervals
- It encourages customers to make purchase decisions as discounts grow
- It works completely client-side without requiring server connections
- Can be added to any page: product pages, collection pages, or homepage

## Installation Method 1: Using the Shopify Theme Editor

1. Log in to your Shopify admin
2. Go to **Online Store** → **Themes**
3. Find your current theme and click **Customize**
4. Navigate to the page where you want to add the timer
5. Click **Add section** and look for "Reverse Auction Timer" in the list
6. Configure the timer settings:
   - Set your start date/time
   - Configure discount percentages and intervals
   - Adjust styling and appearance

## Installation Method 2: Manual File Addition

If the section doesn't appear in your theme editor, you'll need to add it manually:

1. Log in to your Shopify admin
2. Go to **Online Store** → **Themes**
3. Find your current theme and click **Actions** → **Edit code**
4. In the Sections folder, click "Add a new section"
5. Name the file `reverse-auction-timer.liquid`
6. Copy the entire content from the `reverse-auction-timer.liquid` file and paste it
7. Click **Save**
8. Now you can add it to your theme using Method 1 above

## Configuration Options

### Timer Scheduling

- **Start Date**: When the timer begins (YYYY-MM-DD format or "today")
- **Start Hour/Minute**: What time the timer begins
- **Interval Between Discounts**: How often the discount increases (in minutes)

### Discount Settings

- **Starting Discount**: The initial discount percentage
- **Discount Increment**: How much the discount increases each interval
- **Maximum Discount**: The highest discount percentage possible
- **Show Next Discount**: Option to display the upcoming discount level

### Styling Options

- Customize colors, fonts, and layout
- Mobile-responsive design
- Option to hide the timer when maximum discount is reached

## How to Use on Product Pages

For the best results, add the timer to your product template. This encourages customers to purchase before the price increases further.

## Troubleshooting

- **Timer Not Showing**: Make sure the section is properly added to your theme.
- **Timer Not Counting Down**: Verify you've set a future start date and time.
- **Incorrect Timing**: The timer uses your visitor's browser time.

## Need Help?

If you need assistance, please contact us through our support channels.

## License and Usage

This timer section is provided as part of your Shopify app purchase. It may be used on a single Shopify store. 