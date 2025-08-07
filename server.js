require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const schedule = require('node-schedule');
const moment = require('moment-timezone');

// Validate environment variables
const requiredEnvVars = [
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'SHOPIFY_ACCESS_TOKEN',
  'SHOPIFY_SHOP_URL'
];

requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`Missing required environment variable: ${varName}`);
    process.exit(1);
  }
  console.log(`${varName} is set to:`, varName.includes('TOKEN') ? '***' : process.env[varName]);
});

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Add CORS middleware for Shopify store requests
app.use((req, res, next) => {
  // Allow requests from the Shopify store domain
  const shopifyDomain = process.env.SHOPIFY_SHOP_URL || '';
  const allowedOrigins = [
    `https://${shopifyDomain}`,
    'https://admin.shopify.com',
    'https://localhost:3000'
  ];
  
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    // For development/testing, allow all origins
    res.header('Access-Control-Allow-Origin', '*');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Cache-Control', 'no-cache');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Initialize SQLite database
const db = new sqlite3.Database('auctions.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    createTables();
  }
});

function createTables() {
  console.log('Initializing database tables...');
  
  // Check if auctions table exists first
  db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='auctions'", (err, table) => {
    if (err) {
      console.error('Error checking for auctions table:', err);
      return;
    }
    
    if (table) {
      console.log('Auctions table already exists, checking schema...');
      
      // Check if scheduled_start and timezone columns exist
      db.all("PRAGMA table_info(auctions)", (err, columns) => {
        if (err) {
          console.error('Error checking auctions table schema:', err);
          return;
        }
        
        const columnNames = columns.map(col => col.name);
        console.log('Current auctions table columns:', columnNames.join(', '));
        
        let missingColumns = [];
        
        // Check for scheduled_start column
        if (!columnNames.includes('scheduled_start')) {
          console.log('Adding missing scheduled_start column to auctions table');
          missingColumns.push("ALTER TABLE auctions ADD COLUMN scheduled_start DATETIME");
        }
        
        // Check for timezone column
        if (!columnNames.includes('timezone')) {
          console.log('Adding missing timezone column to auctions table');
          missingColumns.push("ALTER TABLE auctions ADD COLUMN timezone TEXT DEFAULT 'CET'");
        }
        
        // Add any missing columns
        if (missingColumns.length > 0) {
          console.log(`Adding ${missingColumns.length} missing columns to auctions table...`);
          
          // Execute each ALTER TABLE statement
          const executeAlter = (index) => {
            if (index >= missingColumns.length) {
              console.log('Schema update completed successfully');
              return;
            }
            
            db.run(missingColumns[index], (err) => {
              if (err) {
                console.error(`Error adding column (${index + 1}/${missingColumns.length}):`, err);
              } else {
                console.log(`Successfully added column (${index + 1}/${missingColumns.length})`);
              }
              
              // Process next column
              executeAlter(index + 1);
            });
          };
          
          // Start processing columns
          executeAlter(0);
        } else {
          console.log('Auctions table schema is up to date');
        }
      });
    } else {
      // Create the table if it doesn't exist
      console.log('Creating auctions table...');
      
      db.run(`CREATE TABLE IF NOT EXISTS auctions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id TEXT NOT NULL,
        original_price REAL NOT NULL,
        current_price REAL NOT NULL,
        interval_minutes INTEGER NOT NULL,
        reduction_percent REAL NOT NULL,
        is_active BOOLEAN DEFAULT 1,
        next_update DATETIME,
        scheduled_start DATETIME,
        timezone TEXT DEFAULT 'CET',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) {
          console.error('Error creating auctions table:', err);
        } else {
          console.log('Auctions table created successfully');
        }
      });
    }
  });
}

// Shopify API helper function
async function shopifyRequest(endpoint, method = 'GET', data = null) {
  const shopUrl = process.env.SHOPIFY_SHOP_URL.replace('https://', '').replace('http://', '').trim();
  const url = `https://${shopUrl}/admin/api/2024-01/${endpoint}${endpoint.includes('?') ? '&' : '?'}access_token=${process.env.SHOPIFY_ACCESS_TOKEN}`;
  
  console.log('Making request to:', url.replace(process.env.SHOPIFY_ACCESS_TOKEN, '***'));
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  };

  if (data) {
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, options);
    console.log('Response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Error response:', errorText);
      throw new Error(`Shopify API error: ${response.status} ${response.statusText}\n${errorText}`);
    }
    
    const json = await response.json();
    return json;
  } catch (error) {
    console.error('Request failed:', error);
    throw error;
  }
}

// Enhanced GraphQL helper with rate limiting and retry logic
async function shopifyGraphQLRequest(query, variables = {}, retryCount = 0) {
  const shopUrl = process.env.SHOPIFY_SHOP_URL.replace('https://', '').replace('http://', '').trim();
  const url = `https://${shopUrl}/admin/api/2024-04/graphql.json`;
  
  // Reduce logging spam for retries
  if (retryCount === 0) {
  console.log('--- Shopify GraphQL Request ---');
  console.log('URL:', url);
  console.log('Query:', query.replace(/\n/g, ' ').replace(/\s+/g, ' '));
  console.log('Variables:', JSON.stringify(variables, null, 2));
  }
  
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({
      query: query,
      variables: variables
    })
  };

  try {
    const response = await fetch(url, options);
    console.log('GraphQL response status:', response.status);
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error('Failed to parse GraphQL response as JSON:', text);
      throw e;
    }
    if (!response.ok) {
      console.error('GraphQL error response:', text);
      throw new Error(`Shopify GraphQL API error: ${response.status} ${response.statusText}\n${text}`);
    }
    
    // Handle rate limiting with exponential backoff
    if (json.errors) {
      console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
      
      const throttledError = json.errors.find(error => 
        error.extensions && error.extensions.code === 'THROTTLED'
      );
      
      if (throttledError && retryCount < 5) {
        const waitTime = Math.min(2000 * Math.pow(2, retryCount), 15000); // 2s, 4s, 8s, 15s, 15s
        console.log(`🚦 THROTTLED - Waiting ${waitTime}ms before retry ${retryCount + 1}/5...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return shopifyGraphQLRequest(query, variables, retryCount + 1);
      }
    }
    
    if (json.data && retryCount === 0) {
      // Only log data for first attempt to reduce spam
      console.log('GraphQL data received successfully');
    }
    return json;
  } catch (error) {
    console.error('GraphQL request failed:', error);
    throw error;
  }
}

// Helper function to fetch all products with GraphQL pagination (ACTIVE products only)
async function fetchAllProducts() {
  console.log('Fetching all ACTIVE products with stock using GraphQL cursor-based pagination...');
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  const PER_PAGE = 50; // GraphQL can handle larger batches
  
  while (hasNextPage) {
    // Create a GraphQL query with proper cursor-based pagination - ONLY ACTIVE PRODUCTS
    const query = `
      query getProducts($first: Int!, $after: String) {
        products(first: $first, after: $after, query: "status:active") {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              tags
              status
              variants(first: 50) {
                edges {
                  node {
                    id
                    price
                    compareAtPrice
                    availableForSale
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const variables = {
      first: PER_PAGE,
      after: cursor
    };
    
    try {
      console.log(`Fetching batch of ${PER_PAGE} products${cursor ? ' after cursor' : ''}...`);
      const response = await shopifyGraphQLRequest(query, variables);
      
      // Extract products from the GraphQL response and filter for eligible variants
      const products = response.data.products.edges.map(edge => {
        const product = edge.node;
        
        // Check if product has AT LEAST ONE variant with stock > 0
        const hasStockVariants = product.variants.edges.some(variantEdge => {
          const variant = variantEdge.node;
          return variant.inventoryQuantity > 0;
        });
        
        if (!hasStockVariants) {
          console.log(`⏭️  Skipping product: ${product.title} (NO variants with stock > 0)`);
          return null; // Will be filtered out
        }
        
        console.log(`📦 Converting product: ${product.title} with ${product.variants.edges.length} variants (has stock variants)`);
        
        // Convert ALL variants (including out-of-stock ones) since product has at least one with stock
        return {
          id: product.id.split('/').pop(),
          title: product.title,
          tags: product.tags,
          status: product.status,
          variants: product.variants.edges.map(variantEdge => {
            const variant = variantEdge.node;
            const convertedVariant = {
              id: variant.id.split('/').pop(),
              admin_graphql_api_id: variant.id,
              price: variant.price,
              compare_at_price: variant.compareAtPrice,
              available_for_sale: variant.availableForSale,
              inventory_quantity: variant.inventoryQuantity
            };
            console.log(`  🔧 Including variant: ${convertedVariant.admin_graphql_api_id} price=${convertedVariant.price} stock=${convertedVariant.inventory_quantity}`);
            return convertedVariant;
          })
        };
      }).filter(product => product !== null); // Remove products with no eligible variants
      
      console.log(`Fetched ${products.length} products`);
      allProducts = [...allProducts, ...products];
      
      // Update pagination info
      const pageInfo = response.data.products.pageInfo;
      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
      
      if (hasNextPage) {
        // Increased delay to respect API rate limits (avoid throttling)
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second between pages
      } else {
        console.log('Reached last page of products');
      }
    } catch (error) {
      console.error('Error fetching products:', error);
      // Try to continue with what we have so far rather than failing completely
      hasNextPage = false;
    }
  }
  
  console.log(`Total products fetched: ${allProducts.length}`);
  return allProducts;
}

// Global state to track the auction
let globalAuctionState = {
  isRunning: false,
  startedAt: null,
  scheduledStartTime: null,
  timezone: 'CET',
  intervalMinutes: 1,
  startingDiscountPercent: 5,
  currentDiscountPercent: 0,
  lastUpdateTime: null,
  products: []
};

// Add timestamp to console logs
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = function(...args) {
  const timestamp = new Date().toISOString();
  originalConsoleLog.apply(console, [`[${timestamp}] [INFO]`, ...args]);
};

console.error = function(...args) {
  const timestamp = new Date().toISOString();
  originalConsoleError.apply(console, [`[${timestamp}] [ERROR]`, ...args]);
};

// Performance monitoring for price updates
let performanceMetrics = {
  lastUpdateDuration: null,
  averageUpdateDuration: null,
  totalUpdates: 0,
  fastestUpdate: null,
  slowestUpdate: null,
  updateHistory: []
};

function recordPerformanceMetric(duration, productCount, variantCount) {
  performanceMetrics.totalUpdates++;
  performanceMetrics.lastUpdateDuration = duration;
  
  // Calculate average
  if (performanceMetrics.averageUpdateDuration === null) {
    performanceMetrics.averageUpdateDuration = duration;
  } else {
    performanceMetrics.averageUpdateDuration = 
      (performanceMetrics.averageUpdateDuration * (performanceMetrics.totalUpdates - 1) + duration) / performanceMetrics.totalUpdates;
  }
  
  // Track fastest and slowest
  if (performanceMetrics.fastestUpdate === null || duration < performanceMetrics.fastestUpdate) {
    performanceMetrics.fastestUpdate = duration;
  }
  if (performanceMetrics.slowestUpdate === null || duration > performanceMetrics.slowestUpdate) {
    performanceMetrics.slowestUpdate = duration;
  }
  
  // Keep history of last 10 updates
  performanceMetrics.updateHistory.push({
    timestamp: new Date().toISOString(),
    duration: duration,
    productCount: productCount,
    variantCount: variantCount,
    productsPerSecond: Math.round((productCount / duration) * 1000),
    variantsPerSecond: Math.round((variantCount / duration) * 1000)
  });
  
  if (performanceMetrics.updateHistory.length > 10) {
    performanceMetrics.updateHistory.shift();
  }
  
  console.log(`📈 PERFORMANCE TRACKING: Update #${performanceMetrics.totalUpdates}`);
  console.log(`   Current: ${(duration/1000).toFixed(2)}s | Average: ${(performanceMetrics.averageUpdateDuration/1000).toFixed(2)}s`);
  console.log(`   Fastest: ${(performanceMetrics.fastestUpdate/1000).toFixed(2)}s | Slowest: ${(performanceMetrics.slowestUpdate/1000).toFixed(2)}s`);
}

// Add a function to log detailed state info regularly
function logDetailedState() {
  console.log('=======================================================');
  console.log('!!! DETAILED AUCTION STATE REPORT - RUNNING EVERY MINUTE !!!');
  console.log('=======================================================');
  console.log('GLOBAL STATE:');
  console.log(` - isRunning: ${globalAuctionState.isRunning}`);
  console.log(` - startedAt: ${globalAuctionState.startedAt ? globalAuctionState.startedAt.toISOString() : 'null'}`);
  console.log(` - scheduledStartTime: ${globalAuctionState.scheduledStartTime ? globalAuctionState.scheduledStartTime.toISOString() : 'null'}`);
  console.log(` - timezone: ${globalAuctionState.timezone}`);
  console.log(` - intervalMinutes: ${globalAuctionState.intervalMinutes}`);
  console.log(` - startingDiscountPercent: ${globalAuctionState.startingDiscountPercent}`);
  console.log(` - currentDiscountPercent: ${globalAuctionState.currentDiscountPercent}`);
  console.log(` - lastUpdateTime: ${globalAuctionState.lastUpdateTime ? globalAuctionState.lastUpdateTime.toISOString() : 'null'}`);
  console.log(` - productsLoaded: ${globalAuctionState.products ? globalAuctionState.products.length : 0}`);
  
  // Query database for all auctions
  db.all('SELECT * FROM auctions', (err, rows) => {
    if (err) {
      console.error('Error fetching auctions for status report:', err);
    } else {
      console.log(`DATABASE STATE: Found ${rows.length} total auctions`);
      console.log(` - Active auctions: ${rows.filter(a => a.is_active === 1).length}`); 
      console.log(` - Scheduled auctions: ${rows.filter(a => a.scheduled_start !== null).length}`);
      
      // Log details of each auction
      rows.forEach((auction, i) => {
        console.log(`AUCTION #${auction.id}:`);
        console.log(` - Product ID: ${auction.product_id}`);
        console.log(` - Is active: ${auction.is_active === 1 ? 'Yes' : 'No'}`);
        console.log(` - Scheduled start: ${auction.scheduled_start || 'Not scheduled'}`);
        console.log(` - Next update: ${auction.next_update || 'N/A'}`);
        console.log(` - Reduction percent: ${auction.reduction_percent}%`);
        console.log(` - Interval minutes: ${auction.interval_minutes}`);
      });
    }
    console.log('=======================================================');
  });
}

// Run the detailed state logger every minute
schedule.scheduleJob('* * * * *', logDetailedState);

// Now add detailed logging to database operations

// Add a wrapper for db.run to add logging
const originalRun = db.run;
db.run = function() {
  const args = Array.from(arguments);
  const sql = args[0];
  
  console.log(`!!! DATABASE OPERATION: ${sql}`);
  
  // If this is an insert/update/delete, log the values
  if (args.length > 1 && Array.isArray(args[1])) {
    console.log(`!!! DATABASE VALUES: ${JSON.stringify(args[1])}`);
  }
  
  return originalRun.apply(this, args);
};

// Add a wrapper for db.all to add logging
const originalAll = db.all;
db.all = function() {
  const args = Array.from(arguments);
  const sql = args[0];
  
  console.log(`!!! DATABASE QUERY: ${sql}`);
  
  return originalAll.apply(this, args);
};

// Modified auction/all route - updated with timezone scheduling
app.post('/auctions/all', async (req, res) => {
  console.log('=======================================================');
  console.log('!!! POST /auctions/all - AUCTION FORM SUBMITTED !!!');
  console.log('=======================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Request from IP: ${req.ip || 'Unknown'}`);
  console.log(`User agent: ${req.headers['user-agent'] || 'Unknown'}`);
  console.log(`Form data in detail:`);
  Object.entries(req.body).forEach(([key, value]) => {
    console.log(`- ${key}: ${value}`);
  });
  
  console.log('=======================================================');
  console.log('--- STARTING/SCHEDULING AUCTION FOR ALL PRODUCTS ---');
  console.log('=======================================================');
  console.log(`REQUEST RECEIVED FROM: ${req.headers['user-agent'] || 'Unknown'}`);
  console.log(`TIMESTAMP: ${new Date().toISOString()}`);
  console.log('Form data received:', req.body);
  
  // Add immediate visible logging
  console.log('!!! AUCTION SCHEDULING INFO !!!');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Form data details: ${JSON.stringify(req.body, null, 2)}`);
  
  const { interval, reductionPercent, initialDiscount, startOption, scheduledTime, timezone } = req.body;
  
  // Validate input parameters
  if (!interval || isNaN(parseInt(interval)) || parseInt(interval) <= 0) {
    console.error('Invalid interval provided:', interval);
    return res.redirect('/?error=Invalid interval. Please provide a positive number.');
  }
  
  if (!reductionPercent || isNaN(parseInt(reductionPercent)) || parseInt(reductionPercent) <= 0 || parseInt(reductionPercent) > 100) {
    console.error('Invalid reduction percentage provided:', reductionPercent);
    return res.redirect('/?error=Invalid reduction percentage. Please provide a number between 1 and 100.');
  }
  
  // Validate scheduled time if scheduling is selected
  const useScheduledStart = startOption === 'scheduled';
  if (useScheduledStart) {
    if (!scheduledTime) {
      console.error('Scheduled start selected but no time provided');
      return res.redirect('/?error=Please provide a start time for the scheduled auction.');
    }
    
    // Basic format validation
    const timeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    if (!timeRegex.test(scheduledTime)) {
      console.error('Invalid scheduled time format:', scheduledTime);
      return res.redirect('/?error=Invalid time format. Please use the date-time picker.');
    }
  }
  
  // Validate timezone
  const selectedTimezone = timezone || 'CET';
  const validTimezones = moment.tz.names();
  if (!validTimezones.includes(selectedTimezone)) {
    console.warn(`Unrecognized timezone: ${selectedTimezone}, defaulting to CET`);
    // Not blocking the request, just using default
  }
  
  try {
    // Clear any existing auctions
    console.log('Clearing existing auctions from database...');
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM auctions', (err) => {
        if (err) {
          console.error('Error clearing existing auctions:', err);
          reject(err);
        } else {
          console.log('Successfully cleared existing auctions');
          resolve();
        }
      });
    });
    
    // Fetch all active products
    console.log('Fetching all active products...');
    const products = await fetchAllProducts();
    console.log(`Found ${products.length} active products`);
    
    // Count valid products (with variants)
    const validProducts = products.filter(p => p && p.variants && p.variants.length > 0);
    console.log(`${validProducts.length} products have valid variants and can be updated`);
    
    if (validProducts.length === 0) {
      console.error('No valid products found for auction');
      return res.redirect('/?error=No valid products found. Please ensure products have variants.');
    }
    
    // Prepare timestamps and running state
    let startTime = new Date();
    let isRunningNow = true;
    
    // Parse scheduled time if provided
    if (useScheduledStart && scheduledTime) {
      console.log('=======================================================');
      console.log('PARSING SCHEDULED TIME');
      console.log('=======================================================');
      console.log(`Original scheduledTime input: ${scheduledTime}`);
      console.log(`Selected timezone: ${selectedTimezone}`);
      
      try {
        // Extract date components from input
        const [datePart, timePart] = scheduledTime.split('T');
        const [year, month, day] = datePart.split('-').map(Number);
        const [hours, minutes] = timePart.split(':').map(Number);
        
        console.log(`Parsed components: Year=${year}, Month=${month}, Day=${day}, Hour=${hours}, Minute=${minutes}`);
        
        // Create a moment in the specified timezone
        const scheduledMoment = moment.tz({
          year: year,
          month: month - 1, // moment months are 0-indexed
          date: day,
          hour: hours,
          minute: minutes
        }, selectedTimezone);
        
        startTime = scheduledMoment.toDate();
        
        console.log(`Parsed scheduled time (moment format): ${scheduledMoment.format()}`);
        console.log(`Converted to Date object: ${startTime.toISOString()}`);
        
        // Log the time in various formats for debugging
        console.log(`Time in ${selectedTimezone}: ${scheduledMoment.format('YYYY-MM-DD HH:mm:ss')}`);
        console.log(`Time in UTC: ${moment(startTime).utc().format('YYYY-MM-DD HH:mm:ss')}`);
        console.log(`Time in server's timezone: ${moment(startTime).format('YYYY-MM-DD HH:mm:ss')}`);
        
        // Check if the scheduled time is valid
        if (isNaN(startTime.getTime())) {
          throw new Error('Invalid date/time');
        }
        
        // Check if the scheduled time is in the future
        const now = new Date();
        isRunningNow = startTime <= now;
        
        const diffMs = startTime - now;
        const diffMins = Math.floor(diffMs / 60000);
        const diffSecs = Math.floor((diffMs % 60000) / 1000);
        
        if (!isRunningNow) {
          console.log(`SCHEDULING: Auction will start at: ${scheduledMoment.format('YYYY-MM-DD HH:mm:ss')} ${selectedTimezone}`);
          console.log(`SCHEDULING: This is ${diffMins} minutes and ${diffSecs} seconds from now`);
          console.log(`SCHEDULING: Current server time: ${moment().format('YYYY-MM-DD HH:mm:ss')}`);
          console.log(`SCHEDULING: Server timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
        } else {
          console.log(`Scheduled time is in the past (${Math.abs(diffMins)} minutes ${Math.abs(diffSecs)} seconds ago), starting auction immediately`);
        }
      } catch (error) {
        console.error("Error parsing scheduled time:", error);
        console.error("Stack trace:", error.stack);
        return res.redirect(`/?error=Error parsing scheduled time: ${error.message}`);
      }
    } else {
      console.log('Starting auction immediately (no scheduling selected)');
    }
    
    // Update the global auction state
    console.log('=======================================================');
    console.log('UPDATING GLOBAL AUCTION STATE');
    console.log('=======================================================');
    
    // FIXED: Apply initial discount only when auction actually starts
    const startingDiscountIncrement = parseInt(reductionPercent) || 5;
    const requestedInitialDiscount = parseInt(initialDiscount) || 0;
    
    let initialDiscountPercent;
    
    if (isRunningNow) {
      // Auction starts immediately - apply initial discount now
      if (requestedInitialDiscount > 0) {
        initialDiscountPercent = requestedInitialDiscount;
        console.log(`🎯 Applying initial discount: ${initialDiscountPercent}% (auction starting now)`);
        
        // Apply the initial discount to products immediately
        if (validProducts && validProducts.length > 0) {
          console.log(`🎯 Applying ${initialDiscountPercent}% initial discount to ${validProducts.length} products...`);
          await updateAllProductPrices(initialDiscountPercent);
          console.log(`✅ Initial ${initialDiscountPercent}% discount applied successfully`);
        }
      } else {
        // No initial discount specified, use starting increment
        const existingDiscountPercent = globalAuctionState.currentDiscountPercent || 0;
        if (existingDiscountPercent === 0) {
          initialDiscountPercent = startingDiscountIncrement;
          console.log(`🆕 Starting fresh with ${initialDiscountPercent}% discount`);
        } else {
          initialDiscountPercent = existingDiscountPercent;
          console.log(`📅 Maintaining current ${initialDiscountPercent}% discount`);
        }
      }
    } else {
      // Auction is scheduled for later - don't apply any discount yet
      initialDiscountPercent = requestedInitialDiscount || 0;
      console.log(`⏰ Auction scheduled for later - initial ${initialDiscountPercent}% discount will be applied at start time`);
    }
    
    globalAuctionState = {
      isRunning: isRunningNow,
      startedAt: isRunningNow ? startTime : null,
      scheduledStartTime: useScheduledStart ? startTime : null,
      timezone: selectedTimezone,
      intervalMinutes: parseInt(interval) || 1,
      startingDiscountPercent: startingDiscountIncrement,
      currentDiscountPercent: initialDiscountPercent,
      lastUpdateTime: isRunningNow ? new Date() : null,
      products: validProducts
    };
    
    console.log(`Auction state configured:`);
    console.log(`- Running now: ${isRunningNow}`);
    console.log(`- Scheduled start: ${useScheduledStart ? startTime.toISOString() : 'N/A'}`);
    console.log(`- Number of products: ${globalAuctionState.products.length}`);
    console.log(`- Initial discount: ${globalAuctionState.currentDiscountPercent}%`);
    console.log(`- Interval: ${globalAuctionState.intervalMinutes} minutes`);
    console.log(`- Timezone: ${selectedTimezone}`);
    
    // Apply the initial discount if starting immediately AND no initial discount was already applied
    if (isRunningNow && requestedInitialDiscount === 0) {
      console.log('Applying initial price discount immediately...');
      await updateAllProductPrices(globalAuctionState.currentDiscountPercent);
      console.log('Initial price discount applied successfully');
    } else if (isRunningNow && requestedInitialDiscount > 0) {
      console.log('Initial discount already applied above, skipping additional discount');
    } else if (!isRunningNow) {
      console.log('⏰ Auction scheduled - no discount applied yet, will apply at start time');
    }
    
    // Set next update time in DB for tracking
    const nextUpdateTime = new Date();
    if (isRunningNow) {
      nextUpdateTime.setMinutes(nextUpdateTime.getMinutes() + parseInt(interval));
      console.log(`Next update scheduled for: ${nextUpdateTime.toISOString()}`);
    } else {
      // If scheduled for the future, the first update will be at the start time
      nextUpdateTime.setTime(startTime.getTime());
      console.log(`First update scheduled for start time: ${nextUpdateTime.toISOString()}`);
    }
    
    // Add more explicit logging before database insert
    if (useScheduledStart && !isRunningNow) {
      console.log('!!! AUCTION SCHEDULED SUCCESSFULLY !!!');
      console.log(`Start time: ${startTime.toISOString()}`);
      console.log(`Timezone: ${selectedTimezone}`);
      console.log(`Interval: ${interval} minutes`);
      console.log(`Starting discount: ${reductionPercent}%`);
    }
    
    // Create one record in the auctions table to track the global auction state
    console.log('=======================================================');
    console.log('!!! SAVING AUCTION TO DATABASE !!!');
    console.log('=======================================================');
    
    console.log('Recording auction state in database...');
    await new Promise((resolve, reject) => {
      const scheduledStartISO = useScheduledStart ? startTime.toISOString().replace('T', ' ').split('.')[0] : null;
      
      console.log('SCHEDULING: Database record being created:');
      console.log(`SCHEDULING: - product_id: global`);
      console.log(`SCHEDULING: - is_active: ${isRunningNow ? 1 : 0}`);
      console.log(`SCHEDULING: - interval_minutes: ${interval}`);
      console.log(`SCHEDULING: - reduction_percent: ${reductionPercent}`);
      console.log(`SCHEDULING: - scheduled_start: ${scheduledStartISO}`);
      console.log(`SCHEDULING: - timezone: ${selectedTimezone}`);
      
      db.run(
        'INSERT INTO auctions (product_id, original_price, current_price, interval_minutes, reduction_percent, next_update, is_active, scheduled_start, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'global', 
          0, 
          0, 
          interval, 
          reductionPercent, 
          nextUpdateTime.toISOString().replace('T', ' ').split('.')[0], 
          isRunningNow ? 1 : 0,
          scheduledStartISO,
          selectedTimezone
        ],
        function(err) {
          if (err) {
            console.error('Database error:', err);
            reject(err);
          } else {
            const insertId = this.lastID;
            console.log(`SCHEDULING: Successfully recorded auction in database with ID: ${insertId}`);
            resolve();
          }
        }
      );
    });
    
    // Log completion message
    if (isRunningNow) {
      console.log('=======================================================');
      console.log('AUCTION STARTED SUCCESSFULLY WITH INITIAL PRICE REDUCTION');
      console.log('=======================================================');
      res.redirect('/?message=Auction started with initial price reduction');
    } else {
      // Format the time in the selected timezone for the message
      const formattedTime = moment(startTime).tz(selectedTimezone).format('YYYY-MM-DD HH:mm:ss');
      console.log('=======================================================');
      console.log(`AUCTION SCHEDULED TO START AT: ${formattedTime} ${selectedTimezone}`);
      console.log('=======================================================');
      res.redirect(`/?message=Auction scheduled to start at ${formattedTime} ${selectedTimezone}`);
    }
  } catch (error) {
    console.error('==== ERROR CREATING AUCTION ====');
    console.error('Error details:', error);
    console.error('Stack trace:', error.stack);
    res.redirect(`/?error=Error creating auction: ${error.message}`);
  }
});

// Modified stop-all-auctions route - ONLY stops auctions (does NOT reset prices)
app.post('/stop-all-auctions', async (req, res) => {
  try {
    console.log('Stopping all auctions immediately...');
    
    // Properly clear the global auction state
    globalAuctionState = {
      isRunning: false,
      startedAt: null,
      scheduledStartTime: null,
      timezone: 'CET',
      intervalMinutes: 30,
      startingDiscountPercent: 5,
      currentDiscountPercent: globalAuctionState.currentDiscountPercent || 0, // Keep current discount
      lastUpdateTime: null,
      products: globalAuctionState.products || [] // Keep products in memory
    };
    
    console.log(`🛑 Auction stopped - maintaining current discount: ${globalAuctionState.currentDiscountPercent}%`);
    
    // Deactivate auction in DB
    await new Promise((resolve, reject) => {
      db.run('UPDATE auctions SET is_active = 0', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // Clear all auction records
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM auctions', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    console.log('All auctions stopped (prices remain unchanged)');
    
    res.redirect('/?message=All auctions stopped successfully (prices not reset)');
  } catch (error) {
    console.error('Error stopping all auctions:', error);
    res.redirect('/?error=Error stopping all auctions: ' + error.message);
  }
});

// NEW: Manual price reset endpoint (separate from stop auctions)
app.post('/reset-all-prices', async (req, res) => {
  try {
    console.log('🔄 Manual price reset requested...');
    
    // Check if we have products to reset
    if (globalAuctionState.products.length === 0) {
      console.log('No products in memory, fetching all products...');
      try {
        const products = await fetchAllProducts();
        globalAuctionState.products = products;
      } catch (error) {
        console.error('Error fetching products:', error);
        res.redirect('/?error=Error fetching products for reset: ' + error.message);
        return;
      }
    }
    
    // Only try to reset prices if we have products
    if (globalAuctionState.products && globalAuctionState.products.length > 0) {
      console.log(`🔄 Resetting prices for ${globalAuctionState.products.length} products...`);
      await resetAllProductPrices();
      console.log('✅ All prices reset to original values');
      res.redirect('/?message=All prices have been reset to original values');
    } else {
      console.log('No products to reset prices for.');
      res.redirect('/?message=No products found to reset prices');
    }
    
  } catch (error) {
    console.error('Error resetting all prices:', error);
    res.redirect('/?error=Error resetting prices: ' + error.message);
  }
});

// NEW: Manual discount endpoint (for pre-auction setup)
app.post('/set-manual-discount', async (req, res) => {
  try {
    const discountPercent = parseInt(req.body.discountPercent) || 10;
    console.log(`🎯 Manual discount requested: ${discountPercent}%`);
    
    // Check if we have products to discount
    if (globalAuctionState.products.length === 0) {
      console.log('No products in memory, fetching all products...');
      try {
        const products = await fetchAllProducts();
        globalAuctionState.products = products;
  } catch (error) {
        console.error('Error fetching products:', error);
        res.redirect('/?error=Error fetching products for discount: ' + error.message);
        return;
      }
    }
    
    // Only try to apply discount if we have products
    if (globalAuctionState.products && globalAuctionState.products.length > 0) {
      console.log(`🎯 Applying ${discountPercent}% discount to ${globalAuctionState.products.length} products...`);
      
      // Update global state to reflect manual discount
      globalAuctionState.currentDiscountPercent = discountPercent;
      
      // Apply the discount using our modern bulk operations
      await updateAllProductPrices(discountPercent);
      
      console.log(`✅ Manual ${discountPercent}% discount applied successfully`);
      res.redirect(`/?message=Manual ${discountPercent}% discount applied to all products`);
    } else {
      console.log('No products found to apply discount to.');
      res.redirect('/?message=No products found to apply discount to');
    }
    
  } catch (error) {
    console.error('Error applying manual discount:', error);
    res.redirect('/?error=Error applying manual discount: ' + error.message);
  }
});

// 2025 MODERN BULK OPERATIONS - Fast price update using productVariantsBulkUpdate
async function updateAllProductPrices(discountPercent) {
  console.log(`🚀 2025 BULK OPERATIONS: Ultra-fast price update using productVariantsBulkUpdate API`);
  const startTime = Date.now();
  console.log(`Timestamp: ${new Date().toISOString()}`);

  // Ensure we have products loaded, if not fetch them
  if (globalAuctionState.products.length === 0) {
    console.log('⚠️ No products in memory, fetching all products first...');
    try {
      const fetchedProducts = await fetchAllProducts();
      globalAuctionState.products = fetchedProducts;
      console.log(`✅ Loaded ${fetchedProducts.length} products into memory`);
    } catch (error) {
      console.error('❌ Failed to fetch products:', error);
      return;
    }
  }

  // Try modern bulk operations first, fallback to old method if needed
  try {
    return await updateAllProductPricesModernBulk(discountPercent);
  } catch (error) {
    console.error('❌ Modern bulk operations failed, falling back to legacy method:', error);
    return await updateAllProductPricesLegacy(discountPercent);
  }
}

// NEW: 2025 Modern Bulk Operations (up to 2,048 variants per operation!)
async function updateAllProductPricesModernBulk(discountPercent) {
  console.log(`🚀 MODERN BULK: Using 2025 productVariantsBulkUpdate API`);
  const startTime = Date.now();

  // Filter out products without variants and ensure they're eligible for updates
  const validProducts = globalAuctionState.products.filter(p => {
    if (!p || !p.variants || p.variants.length === 0) return false;
    
    // Skip draft products 
    if (p.status && p.status.toLowerCase() === 'draft') {
      console.log(`⏭️  Skipping DRAFT product: ${p.title}`);
      return false;
    }
    
    // Check if product has AT LEAST ONE variant with stock > 0
    const hasStockVariants = p.variants.some(v => {
      return v.inventory_quantity > 0;
    });
    
    if (!hasStockVariants) {
      console.log(`⏭️  Skipping product: ${p.title} (NO variants with stock > 0)`);
      return false;
    }
    
    return true;
  });
  
  console.log(`Found ${validProducts.length} eligible products with variants (active, in-stock)`);

  if (validProducts.length === 0) {
    console.log('❌ No eligible products to update (all are draft or out of stock).');
    return;
  }

  // Prepare all variant updates for bulk operation
  const allVariantUpdates = [];
  let totalVariantsCount = 0;

  for (const product of validProducts) {
    try {
      // Handle both GraphQL edges format and REST format
      const variants = product.variants.edges ? 
        product.variants.edges.map(edge => edge.node) : 
        product.variants;

      for (const variant of variants) {
        // Only skip variants with invalid prices (since product already passed stock check)
        const hasPrice = variant.price && parseFloat(variant.price) > 0;
        
        if (!hasPrice) {
          console.log(`  ⏭️ Skipping variant ${variant.admin_graphql_api_id || variant.id}: invalid price=${variant.price}`);
          continue;
        }
        
        const variantId = variant.admin_graphql_api_id || variant.id;
        const originalPrice = variant.compare_at_price || variant.compareAtPrice || variant.price;
        const discountedPrice = (parseFloat(originalPrice) * (100 - discountPercent) / 100).toFixed(2);

        allVariantUpdates.push({
          id: variantId,
          price: discountedPrice,
          compareAtPrice: originalPrice
        });
        totalVariantsCount++;
        
        console.log(`  💰 Including variant: ${variantId} stock=${variant.inventory_quantity} price=${originalPrice} → ${discountedPrice}`);
      }
  } catch (error) {
      console.error(`❌ Error preparing product ${product.id}:`, error);
    }
  }

  console.log(`💰 Prepared ${allVariantUpdates.length} variant updates for bulk operation`);

  // Check bulk operation limits (2,048 variants max per operation)
  const BULK_LIMIT = 2000; // Use 2000 to be safe
  
  if (allVariantUpdates.length <= BULK_LIMIT) {
    // Single bulk operation
    console.log(`✅ Using single bulk operation for ${allVariantUpdates.length} variants`);
    const result = await executeBulkVariantUpdate(allVariantUpdates, discountPercent);
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`🎉 MODERN BULK COMPLETED in ${duration}ms (${(duration/1000).toFixed(2)}s)`);
    console.log(`⚡ Speed: ${Math.round((allVariantUpdates.length / duration) * 1000)} variants/second`);
    
    // Record performance metrics
    recordPerformanceMetric(duration, validProducts.length, allVariantUpdates.length);
    
    return result;
  } else {
    // Multiple bulk operations for large datasets
    console.log(`📦 Splitting ${allVariantUpdates.length} variants into chunks of ${BULK_LIMIT}`);
    
    const chunks = [];
    for (let i = 0; i < allVariantUpdates.length; i += BULK_LIMIT) {
      chunks.push(allVariantUpdates.slice(i, i + BULK_LIMIT));
    }
    
    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`📦 Processing bulk chunk ${i + 1}/${chunks.length} (${chunks[i].length} variants)`);
      const result = await executeBulkVariantUpdate(chunks[i], discountPercent);
      results.push(result);
      
      // Small delay between chunks
      if (i < chunks.length - 1) {
        console.log('⏱️ Waiting 2s between bulk operations...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`🎉 ALL MODERN BULK OPERATIONS COMPLETED in ${duration}ms (${(duration/1000).toFixed(2)}s)`);
    console.log(`⚡ Speed: ${Math.round((allVariantUpdates.length / duration) * 1000)} variants/second`);
    
    // Record performance metrics
    recordPerformanceMetric(duration, validProducts.length, allVariantUpdates.length);
    
    return results;
  }
}

// Execute a single bulk variant update using 2024-04+ API  
async function executeBulkVariantUpdate(variantUpdates, discountPercent) {
  console.log(`🚀 Executing bulk variant update for ${variantUpdates.length} variants`);
  
  // Try the modern bulk update first
  try {
    const mutation = `
      mutation productVariantsBulkUpdate($variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(variants: $variants) {
          productVariants {
            id
            price
            compareAtPrice
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      variants: variantUpdates.map(variant => ({
        id: variant.id,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice
      }))
    };

    const response = await shopifyGraphQLRequest(mutation, variables);
    
    if (response.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
      console.error('❌ Modern bulk update errors:', response.data.productVariantsBulkUpdate.userErrors);
      throw new Error(`Modern bulk update failed: ${JSON.stringify(response.data.productVariantsBulkUpdate.userErrors)}`);
    }

    if (response.data?.productVariantsBulkUpdate?.productVariants) {
      const updatedVariants = response.data.productVariantsBulkUpdate.productVariants;
      console.log(`✅ Modern bulk update successful: ${updatedVariants.length} variants updated`);
      
      return {
        success: true,
        updatedCount: updatedVariants.length,
        variants: updatedVariants
      };
    }
    
    throw new Error('No productVariants in response');
  } catch (error) {
    console.error('❌ Modern bulk update failed, falling back to individual updates:', error.message);
    
    // Fallback to individual variant updates (guaranteed to work)
    return await executeIndividualVariantUpdates(variantUpdates, discountPercent);
  }
}

// Fallback: Individual variant updates (works on all API versions)
async function executeIndividualVariantUpdates(variantUpdates, discountPercent) {
  console.log(`🔄 Fallback: Using individual variant updates for ${variantUpdates.length} variants`);
  
  const BATCH_SIZE = 10;
  const DELAY_MS = 100;
  let successCount = 0;
  
  // Process in small batches to avoid overwhelming the API
  for (let i = 0; i < variantUpdates.length; i += BATCH_SIZE) {
    const batch = variantUpdates.slice(i, i + BATCH_SIZE);
    console.log(`📦 Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(variantUpdates.length/BATCH_SIZE)} (${batch.length} variants)`);
    
    const batchPromises = batch.map(async (variant) => {
      try {
        const mutation = `
          mutation productVariantUpdate($input: ProductVariantInput!) {
            productVariantUpdate(input: $input) {
              productVariant {
                id
                price
                compareAtPrice
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const variables = {
          input: {
            id: variant.id,
            price: variant.price,
            compareAtPrice: variant.compareAtPrice
          }
        };

        const response = await shopifyGraphQLRequest(mutation, variables);
        
        if (response.data?.productVariantUpdate?.userErrors?.length > 0) {
          console.error(`❌ Error updating variant ${variant.id}:`, response.data.productVariantUpdate.userErrors);
          return { success: false, id: variant.id };
        }

        return { success: true, id: variant.id, variant: response.data.productVariantUpdate.productVariant };
      } catch (error) {
        console.error(`❌ Failed to update variant ${variant.id}:`, error.message);
        return { success: false, id: variant.id };
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    const batchSuccessCount = batchResults.filter(r => r.success).length;
    successCount += batchSuccessCount;
    
    console.log(`✅ Batch completed: ${batchSuccessCount}/${batch.length} variants updated`);
    
    // Add delay between batches to respect rate limits
    if (i + BATCH_SIZE < variantUpdates.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }
  
  console.log(`🎉 Individual updates completed: ${successCount}/${variantUpdates.length} variants updated`);
  
  return {
    success: true,
    updatedCount: successCount,
    method: 'individual',
    variants: []
  };
}

// LEGACY: Keep the old optimized method as fallback
async function updateAllProductPricesLegacy(discountPercent) {
  console.log(`🔄 FALLBACK: Using legacy optimized method for ${discountPercent}% discount`);
  const startTime = Date.now();

  // Filter out products without variants to avoid errors
  const validProducts = globalAuctionState.products.filter(p => p && p.variants && p.variants.length > 0);
  console.log(`Found ${validProducts.length} valid products with variants out of ${globalAuctionState.products.length} total products`);

  if (validProducts.length === 0) {
    console.log('❌ No valid products to update prices for.');
    return;
  }

  // PERFORMANCE OPTIMIZATIONS:
  // 1. Larger batch sizes for better throughput
  // 2. Bulk GraphQL mutations for multiple variants per call
  // 3. Reduced delays with intelligent rate limiting
  // 4. Parallel processing of all operations
  
  const BATCH_SIZE = 8; // Reduced to avoid throttling
  const VARIANT_BATCH_SIZE = 20; // Reduced to avoid throttling
  const BATCH_DELAY_MS = 1500; // Increased delay to respect rate limits
  const MAX_CONCURRENT_REQUESTS = 2; // Reduced concurrent requests to avoid throttling

  // Create batches for processing
  const batches = [];
  for (let i = 0; i < validProducts.length; i += BATCH_SIZE) {
    batches.push(validProducts.slice(i, i + BATCH_SIZE));
  }

  let allVariantUpdates = [];
  let productTagUpdates = [];
  let processedCount = 0;

  console.log(`🔧 OPTIMIZED: Preparing bulk operations for ${validProducts.length} products in ${batches.length} batches`);

  // PHASE 1: Prepare all updates in memory first (very fast)
  for (const [batchIndex, batch] of batches.entries()) {
    console.log(`📦 Preparing batch ${batchIndex + 1}/${batches.length} (${batch.length} products)`);

    for (const product of batch) {
        try {
          // Ensure product ID is valid and in the correct format
          const rawProductId = (product.id || '').toString().replace(/\.0$/, '');
          const productId = rawProductId.includes('gid://') ? rawProductId : `gid://shopify/Product/${rawProductId}`;

        // Prepare product tag updates
          const tagList = product.tags ? (typeof product.tags === 'string' ? product.tags.split(', ') : []) : [];
          const filteredTags = tagList.filter(tag => !tag.startsWith('discount:'));
          filteredTags.push(`discount:${discountPercent}`);

        productTagUpdates.push({
          id: productId,
          tags: filteredTags.join(', ')
        });

                // Prepare variant price updates - handle GraphQL edge format
        let variants = [];
        
        // Handle GraphQL edges format from fetchAllProducts
        if (product.variants && product.variants.edges) {
          variants = product.variants.edges.map(edge => {
            const variant = edge.node;
            const variantId = variant.id;
            const originalPrice = variant.compareAtPrice || variant.price;
            const discountedPrice = (parseFloat(originalPrice) * (100 - discountPercent) / 100).toFixed(2);

            console.log(`🔧 Preparing variant ${variantId}: ${originalPrice} -> ${discountedPrice} (${discountPercent}% off)`);

            return {
              id: variantId,
              price: discountedPrice,
              compareAtPrice: originalPrice
            };
          });
        } 
        // Handle direct variants array (legacy format)
        else if (product.variants && Array.isArray(product.variants)) {
          variants = product.variants.map(variant => {
            let variantId;
            let originalPrice;
            let compareAtPrice;

            if (variant.admin_graphql_api_id) {
              variantId = variant.admin_graphql_api_id;
              originalPrice = variant.compare_at_price || variant.price;
              compareAtPrice = variant.compare_at_price || variant.price;
            } else if (variant.node) {
              variantId = variant.node.id;
              originalPrice = variant.node.compareAtPrice || variant.node.price;
              compareAtPrice = variant.node.compareAtPrice || variant.node.price;
            } else {
              const rawVariantId = (variant.id || '').toString().replace(/\.0$/, '');
              variantId = rawVariantId.includes('gid://') ? rawVariantId : `gid://shopify/ProductVariant/${rawVariantId}`;
              originalPrice = variant.compare_at_price || variant.price;
              compareAtPrice = variant.compare_at_price || variant.price;
            }

            const discountedPrice = (parseFloat(originalPrice) * (100 - discountPercent) / 100).toFixed(2);

            console.log(`🔧 Preparing variant ${variantId}: ${originalPrice} -> ${discountedPrice} (${discountPercent}% off)`);

            return {
              id: variantId,
              price: discountedPrice,
              compareAtPrice: compareAtPrice
            };
          }).filter(v => v.id);
        }
        
        variants = variants.filter(v => v.id);

        allVariantUpdates.push(...variants);
        processedCount++;

        } catch (error) {
          console.error(`Error preparing product data for ${product.id || 'unknown'}:`, error);
      }
    }
  }

  console.log(`✅ Prepared ${processedCount} products and ${allVariantUpdates.length} variant updates`);

  // PHASE 2: Execute bulk operations with optimized concurrency
  try {
    console.log(`🚀 OPTIMIZED: Starting bulk API operations...`);
    
    // Create semaphore for controlling concurrency
    let activeTasks = 0;
    const maxConcurrent = MAX_CONCURRENT_REQUESTS;
    
    const runWithConcurrencyLimit = async (taskFn) => {
      while (activeTasks >= maxConcurrent) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      activeTasks++;
      try {
        return await taskFn();
      } finally {
        activeTasks--;
      }
    };

    // BULK VARIANT UPDATES: Process variants in large batches
    const variantBatches = [];
    for (let i = 0; i < allVariantUpdates.length; i += VARIANT_BATCH_SIZE) {
      variantBatches.push(allVariantUpdates.slice(i, i + VARIANT_BATCH_SIZE));
    }

    console.log(`💰 Processing ${allVariantUpdates.length} variant price updates in ${variantBatches.length} bulk operations`);

    // Execute variant updates with bulk mutations
    const variantPromises = variantBatches.map((variantBatch, batchIndex) => 
      runWithConcurrencyLimit(async () => {
        console.log(`💵 Processing variant batch ${batchIndex + 1}/${variantBatches.length} (${variantBatch.length} variants)`);
        
        // Use bulk mutation for multiple variants
        const bulkVariantMutation = `
          mutation bulkProductVariantUpdate {
            ${variantBatch.map((variant, index) => `
              variant${index}: productVariantUpdate(input: {
                id: "${variant.id}"
                price: "${variant.price}"
                compareAtPrice: "${variant.compareAtPrice}"
              }) {
                productVariant {
                  id
                  price
                }
                userErrors {
                  field
                  message
                }
              }
            `).join('\n')}
          }
        `;

        try {
          const result = await shopifyGraphQLRequest(bulkVariantMutation, {});
          
          // Enhanced error checking and logging
          let successCount = 0;
          let errorCount = 0;
          
          for (let i = 0; i < variantBatch.length; i++) {
            const variantResult = result.data?.[`variant${i}`];
            if (variantResult?.userErrors?.length > 0) {
              console.error(`❌ Variant ${variantBatch[i].id} update failed:`, variantResult.userErrors);
              errorCount++;
            } else if (variantResult?.productVariant?.id) {
              console.log(`✅ Updated variant ${variantResult.productVariant.id} to price ${variantResult.productVariant.price}`);
              successCount++;
            } else {
              console.warn(`⚠️ Unexpected result for variant ${variantBatch[i].id}:`, variantResult);
              errorCount++;
            }
          }
          
          console.log(`✅ Completed variant batch ${batchIndex + 1}/${variantBatches.length}: ${successCount} success, ${errorCount} errors`);
          return { success: true, count: successCount };
        } catch (error) {
          console.error(`❌ Critical error in variant batch ${batchIndex + 1}:`, error);
          console.error(`❌ Mutation that failed:`, bulkVariantMutation.substring(0, 500) + '...');
          
          // Fallback to individual variant updates for this batch
          console.log(`🔄 Falling back to individual updates for batch ${batchIndex + 1}`);
          const individualPromises = variantBatch.map(async variant => {
            try {
              const singleVariantMutation = `
            mutation updateProductVariant($input: ProductVariantInput!) {
              productVariantUpdate(input: $input) {
                    productVariant { id price }
                    userErrors { field message }
                  }
                }
              `;
              
              await shopifyGraphQLRequest(singleVariantMutation, {
              input: {
                id: variant.id,
                price: variant.price,
                compareAtPrice: variant.compareAtPrice
              }
              });
              
              return { success: true };
            } catch (err) {
              console.error(`Individual variant update failed for ${variant.id}:`, err);
              return { success: false };
            }
          });
          
          const individualResults = await Promise.all(individualPromises);
          const successCount = individualResults.filter(r => r.success).length;
          console.log(`🔄 Fallback completed: ${successCount}/${variantBatch.length} variants updated`);
          
          return { success: true, count: successCount };
        }
      })
    );

    // BULK PRODUCT TAG UPDATES: Process products in batches
    const productBatches = [];
    for (let i = 0; i < productTagUpdates.length; i += BATCH_SIZE) {
      productBatches.push(productTagUpdates.slice(i, i + BATCH_SIZE));
    }

    console.log(`🏷️  Processing ${productTagUpdates.length} product tag updates in ${productBatches.length} bulk operations`);

    const productPromises = productBatches.map((productBatch, batchIndex) => 
      runWithConcurrencyLimit(async () => {
        console.log(`🏷️  Processing product batch ${batchIndex + 1}/${productBatches.length} (${productBatch.length} products)`);
        
        // Use bulk mutation for multiple products
        const bulkProductMutation = `
          mutation bulkProductUpdate {
            ${productBatch.map((product, index) => `
              product${index}: productUpdate(product: {
                id: "${product.id}"
                tags: "${product.tags}"
              }) {
                product {
                  id
                  title
                }
                userErrors {
                  field
                  message
                }
              }
            `).join('\n')}
          }
        `;

        try {
          const result = await shopifyGraphQLRequest(bulkProductMutation, {});
          
          // Check for errors in any of the product updates
          for (let i = 0; i < productBatch.length; i++) {
            const productResult = result.data?.[`product${i}`];
            if (productResult?.userErrors?.length > 0) {
              console.error(`Product ${productBatch[i].id} update failed:`, productResult.userErrors);
            }
          }
          
          console.log(`✅ Completed product batch ${batchIndex + 1}/${productBatches.length}`);
          return { success: true, count: productBatch.length };
        } catch (error) {
          console.error(`❌ Error in product batch ${batchIndex + 1}:`, error);
          return { success: false, count: 0 };
        }
      })
    );

    // Execute all operations in parallel
    console.log(`⚡ Executing all bulk operations in parallel...`);
    const [variantResults, productResults] = await Promise.all([
      Promise.all(variantPromises),
      Promise.all(productPromises)
    ]);

    // Calculate results
    const totalVariantsUpdated = variantResults.reduce((sum, result) => sum + (result.count || 0), 0);
    const totalProductsUpdated = productResults.reduce((sum, result) => sum + (result.count || 0), 0);
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    const productsPerSecond = Math.round((totalProductsUpdated / duration) * 1000);
    const variantsPerSecond = Math.round((totalVariantsUpdated / duration) * 1000);

    console.log(`🎉 OPTIMIZED BULK UPDATE COMPLETED!`);
    console.log(`⏱️  Total time: ${duration}ms (${(duration/1000).toFixed(2)}s)`);
    console.log(`📊 Performance: ${productsPerSecond} products/sec, ${variantsPerSecond} variants/sec`);
    console.log(`✅ Products updated: ${totalProductsUpdated}/${productTagUpdates.length}`);
    console.log(`✅ Variants updated: ${totalVariantsUpdated}/${allVariantUpdates.length}`);
    console.log(`💯 Success rate: ${Math.round((totalVariantsUpdated/allVariantUpdates.length)*100)}%`);

    // Record performance metrics
    recordPerformanceMetric(duration, totalProductsUpdated, totalVariantsUpdated);

    // Performance improvement note
    if (duration < 10000) { // Less than 10 seconds
      console.log(`🚀 SPEED IMPROVEMENT: Update completed in under 10 seconds!`);
    } else if (duration < 30000) { // Less than 30 seconds
      console.log(`⚡ SPEED IMPROVEMENT: Update completed in under 30 seconds!`);
    } else if (duration < 60000) { // Less than 1 minute
      console.log(`⏱️  SPEED IMPROVEMENT: Update completed in under 1 minute!`);
    }

  } catch (error) {
    console.error(`❌ Critical error in bulk operations:`, error);
    
    // Fallback to original method if bulk operations fail completely
    console.log(`🔄 Falling back to original update method...`);
    return await updateAllProductPricesOriginal(discountPercent);
  }

  console.log(`!!! OPTIMIZED PRICE UPDATE OPERATION COMPLETED !!!`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Successfully updated products to ${discountPercent}% discount`);
  console.log(`Next scheduled update: ${globalAuctionState.lastUpdateTime ? new Date(globalAuctionState.lastUpdateTime.getTime() + globalAuctionState.intervalMinutes * 60000).toISOString() : 'Not scheduled'}`);
}

// Keep the original function as a fallback
async function updateAllProductPricesOriginal(discountPercent) {
  console.log(`🔄 FALLBACK: Using original price update method for ${discountPercent}% discount`);
  
  const validProducts = globalAuctionState.products.filter(p => p && p.variants && p.variants.length > 0);
  
  if (validProducts.length === 0) {
    console.log('No valid products to update prices for.');
    return;
  }
  
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 500;
  
  const batches = [];
  for (let i = 0; i < validProducts.length; i += BATCH_SIZE) {
    batches.push(validProducts.slice(i, i + BATCH_SIZE));
  }
  
  for (const [index, batch] of batches.entries()) {
    console.log(`Processing fallback batch ${index + 1}/${batches.length}`);

    const updatePromises = batch.map(async (product) => {
      try {
        const rawProductId = (product.id || '').toString().replace(/\.0$/, '');
        const productId = rawProductId.includes('gid://') ? rawProductId : `gid://shopify/Product/${rawProductId}`;

        const tagList = product.tags ? (typeof product.tags === 'string' ? product.tags.split(', ') : []) : [];
        const filteredTags = tagList.filter(tag => !tag.startsWith('discount:'));
        filteredTags.push(`discount:${discountPercent}`);

        // Update product tags
        const productMutation = `
          mutation updateProduct($product: ProductInput!) {
            productUpdate(product: $product) {
              product { id title }
              userErrors { field message }
            }
          }
        `;

        await shopifyGraphQLRequest(productMutation, {
          product: { id: productId, tags: filteredTags.join(', ') }
        });

        // Update variants
        const variantPromises = (product.variants || []).map(async variant => {
          let variantId;
          let originalPrice;
          let compareAtPrice;

          if (variant.admin_graphql_api_id) {
            variantId = variant.admin_graphql_api_id;
            originalPrice = variant.compare_at_price || variant.price;
            compareAtPrice = variant.compare_at_price || variant.price;
          } else {
            const rawVariantId = (variant.id || '').toString().replace(/\.0$/, '');
            variantId = rawVariantId.includes('gid://') ? rawVariantId : `gid://shopify/ProductVariant/${rawVariantId}`;
            originalPrice = variant.compare_at_price || variant.price;
            compareAtPrice = variant.compare_at_price || variant.price;
          }

          const discountedPrice = (parseFloat(originalPrice) * (100 - discountPercent) / 100).toFixed(2);

          const variantMutation = `
            mutation updateProductVariant($input: ProductVariantInput!) {
              productVariantUpdate(input: $input) {
                productVariant { id price }
                userErrors { field message }
              }
            }
          `;

          await shopifyGraphQLRequest(variantMutation, {
            input: {
              id: variantId,
              price: discountedPrice,
              compareAtPrice: compareAtPrice
            }
          });
        });

        await Promise.all(variantPromises);
        return { success: true };
      } catch (error) {
        console.error(`Error updating product ${product.id}:`, error);
        return { success: false };
      }
    });

    await Promise.all(updatePromises);

    if (index < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
}

// 2025 MODERN BULK OPERATIONS - Fast price reset using productVariantsBulkUpdate
async function resetAllProductPrices() {
  console.log(`🔄 2025 BULK OPERATIONS: Ultra-fast price reset using productVariantsBulkUpdate API`);
  const startTime = Date.now();
  
  // Ensure we have products loaded, if not fetch them
  if (globalAuctionState.products.length === 0) {
    console.log('⚠️ No products in memory, fetching all products first...');
    try {
      const fetchedProducts = await fetchAllProducts();
      globalAuctionState.products = fetchedProducts;
      console.log(`✅ Loaded ${fetchedProducts.length} products into memory`);
    } catch (error) {
      console.error('❌ Failed to fetch products:', error);
      return;
    }
  }

  // Try modern bulk operations first, fallback to old method if needed
  try {
    return await resetAllProductPricesModernBulk();
  } catch (error) {
    console.error('❌ Modern bulk reset failed, falling back to legacy method:', error);
    return await resetAllProductPricesLegacy();
  }
}

// NEW: 2025 Modern Bulk Reset Operations  
async function resetAllProductPricesModernBulk() {
  console.log(`🔄 MODERN BULK RESET: Using 2025 productVariantsBulkUpdate API`);
  const startTime = Date.now();

  // Filter out products without variants and ensure they're eligible for resets
  const validProducts = globalAuctionState.products.filter(p => {
    if (!p || !p.variants || p.variants.length === 0) return false;
    
    // Skip draft products 
    if (p.status && p.status.toLowerCase() === 'draft') {
      console.log(`⏭️  Skipping DRAFT product in reset: ${p.title}`);
      return false;
    }
    
    // Check if product has AT LEAST ONE variant with stock > 0
    const hasStockVariants = p.variants.some(v => {
      return v.inventory_quantity > 0;
    });
    
    if (!hasStockVariants) {
      console.log(`⏭️  Skipping product in reset: ${p.title} (NO variants with stock > 0)`);
      return false;
    }
    
    return true;
  });
  
  console.log(`Found ${validProducts.length} eligible products for reset (active, in-stock)`);

  if (validProducts.length === 0) {
    console.log('❌ No eligible products to reset (all are draft or out of stock).');
    return;
  }

  // Prepare all variant resets for bulk operation
  const allVariantResets = [];

  for (const product of validProducts) {
    try {
      // Handle both GraphQL edges format and REST format
      const variants = product.variants.edges ? 
        product.variants.edges.map(edge => edge.node) : 
        product.variants;

      for (const variant of variants) {
        // Only skip variants with invalid prices (since product already passed stock check)
        const hasPrice = variant.price && parseFloat(variant.price) > 0;
        
        if (!hasPrice) {
          console.log(`  ⏭️ Skipping variant reset ${variant.admin_graphql_api_id || variant.id}: invalid price=${variant.price}`);
          continue;
        }
        
        const variantId = variant.admin_graphql_api_id || variant.id;
        const originalPrice = variant.compare_at_price || variant.compareAtPrice || variant.price;

        allVariantResets.push({
          id: variantId,
          price: originalPrice,
          compareAtPrice: originalPrice
        });
        
        console.log(`  🔄 Including variant reset: ${variantId} stock=${variant.inventory_quantity} price=${originalPrice}`);
      }
    } catch (error) {
      console.error(`❌ Error preparing reset for product ${product.id}:`, error);
    }
  }

  console.log(`🔄 Prepared ${allVariantResets.length} variant resets for bulk operation`);

  // Check bulk operation limits (2,048 variants max per operation)
  const BULK_LIMIT = 2000; // Use 2000 to be safe
  
  if (allVariantResets.length <= BULK_LIMIT) {
    // Single bulk operation
    console.log(`✅ Using single bulk reset operation for ${allVariantResets.length} variants`);
    const result = await executeBulkVariantUpdate(allVariantResets, 0);
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`🎉 MODERN BULK RESET COMPLETED in ${duration}ms (${(duration/1000).toFixed(2)}s)`);
    console.log(`⚡ Speed: ${Math.round((allVariantResets.length / duration) * 1000)} variants/second`);
    
    return result;
  } else {
    // Multiple bulk operations for large datasets
    console.log(`📦 Splitting ${allVariantResets.length} variants into reset chunks of ${BULK_LIMIT}`);
    
    const chunks = [];
    for (let i = 0; i < allVariantResets.length; i += BULK_LIMIT) {
      chunks.push(allVariantResets.slice(i, i + BULK_LIMIT));
    }
    
    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`📦 Processing bulk reset chunk ${i + 1}/${chunks.length} (${chunks[i].length} variants)`);
      const result = await executeBulkVariantUpdate(chunks[i], 0);
      results.push(result);
      
      // Small delay between chunks
      if (i < chunks.length - 1) {
        console.log('⏱️ Waiting 2s between bulk reset operations...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`🎉 ALL MODERN BULK RESETS COMPLETED in ${duration}ms (${(duration/1000).toFixed(2)}s)`);
    console.log(`⚡ Speed: ${Math.round((allVariantResets.length / duration) * 1000)} variants/second`);
    
    return results;
  }
}

// LEGACY: Keep the old reset method as fallback
async function resetAllProductPricesLegacy() {
  console.log(`🔄 FALLBACK: Using legacy reset method`);
  const startTime = Date.now();

  // Filter out products without variants to avoid errors
  const validProducts = globalAuctionState.products.filter(p => p && p.variants && p.variants.length > 0);
  console.log(`Found ${validProducts.length} valid products with variants out of ${globalAuctionState.products.length} total products`);
  
  if (validProducts.length === 0) {
    console.log('❌ No valid products to reset prices for.');
    return;
  }
  
  // Use conservative settings to avoid throttling
  const BATCH_SIZE = 8;
  const VARIANT_BATCH_SIZE = 20;
  const MAX_CONCURRENT_REQUESTS = 2;
  
  let allVariantUpdates = [];
  let productTagUpdates = [];
  let processedCount = 0;

  console.log(`🔧 OPTIMIZED: Preparing bulk reset operations for ${validProducts.length} products`);

  // PHASE 1: Prepare all updates in memory first
  for (const product of validProducts) {
    try {
          const rawProductId = (product.id || '').toString().replace(/\.0$/, '');
          const productId = rawProductId.includes('gid://') ? rawProductId : `gid://shopify/Product/${rawProductId}`;
          
          // Remove discount tags
          const tagList = product.tags ? (typeof product.tags === 'string' ? product.tags.split(', ') : []) : [];
          const filteredTags = tagList.filter(tag => !tag.startsWith('discount:'));
          
      productTagUpdates.push({
        id: productId,
        tags: filteredTags.join(', ')
      });
      
            // Prepare variant price resets - handle GraphQL edge format
      let variants = [];
      
      // Handle GraphQL edges format from fetchAllProducts
      if (product.variants && product.variants.edges) {
        variants = product.variants.edges.map(edge => {
          const variant = edge.node;
          const variantId = variant.id;
          const originalPrice = variant.compareAtPrice || variant.price;

          console.log(`🔄 Preparing reset for variant ${variantId}: -> ${originalPrice}`);

          return {
            id: variantId,
            price: originalPrice,
            compareAtPrice: originalPrice
          };
        });
      } 
      // Handle direct variants array (legacy format)
      else if (product.variants && Array.isArray(product.variants)) {
        variants = product.variants.map(variant => {
            let variantId;
            let compareAtPrice;
            
            if (variant.admin_graphql_api_id) {
              variantId = variant.admin_graphql_api_id;
              compareAtPrice = variant.compare_at_price || variant.price;
            } else if (variant.node) {
              variantId = variant.node.id;
              compareAtPrice = variant.node.compareAtPrice || variant.node.price;
            } else {
              const rawVariantId = (variant.id || '').toString().replace(/\.0$/, '');
              variantId = rawVariantId.includes('gid://') ? rawVariantId : `gid://shopify/ProductVariant/${rawVariantId}`;
              compareAtPrice = variant.compare_at_price || variant.price;
            }

          console.log(`🔄 Preparing reset for variant ${variantId}: -> ${compareAtPrice}`);
            
            return {
              id: variantId,
              price: compareAtPrice,
              compareAtPrice: compareAtPrice
            };
          }).filter(v => v.id);
      }
      
      variants = variants.filter(v => v.id);
          
      allVariantUpdates.push(...variants);
      processedCount++;
      
        } catch (error) {
      console.error(`Error preparing reset data for ${product.id || 'unknown'}:`, error);
    }
  }

  console.log(`✅ Prepared ${processedCount} products and ${allVariantUpdates.length} variant resets`);

  // PHASE 2: Execute bulk reset operations
  try {
    console.log(`🚀 OPTIMIZED: Starting bulk reset operations...`);
    
    // Create semaphore for controlling concurrency
    let activeTasks = 0;
    const maxConcurrent = MAX_CONCURRENT_REQUESTS;
    
    const runWithConcurrencyLimit = async (taskFn) => {
      while (activeTasks >= maxConcurrent) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      activeTasks++;
      try {
        return await taskFn();
      } finally {
        activeTasks--;
      }
    };

    // BULK VARIANT RESETS: Process variants in large batches
    const variantBatches = [];
    for (let i = 0; i < allVariantUpdates.length; i += VARIANT_BATCH_SIZE) {
      variantBatches.push(allVariantUpdates.slice(i, i + VARIANT_BATCH_SIZE));
    }

    console.log(`💰 Processing ${allVariantUpdates.length} variant price resets in ${variantBatches.length} bulk operations`);

    // Execute variant resets with bulk mutations (with delays to avoid throttling)
    for (let batchIndex = 0; batchIndex < variantBatches.length; batchIndex++) {
      const variantBatch = variantBatches[batchIndex];
      
      await runWithConcurrencyLimit(async () => {
        console.log(`💵 Processing reset batch ${batchIndex + 1}/${variantBatches.length} (${variantBatch.length} variants)`);
        
        // Use bulk mutation for multiple variants
        const bulkVariantMutation = `
          mutation bulkProductVariantReset {
            ${variantBatch.map((variant, index) => `
              variant${index}: productVariantUpdate(input: {
                id: "${variant.id}"
                price: "${variant.price}"
                compareAtPrice: "${variant.compareAtPrice}"
              }) {
                productVariant {
                  id
                  price
                }
                userErrors {
                  field
                  message
                }
              }
            `).join('\n')}
          }
        `;

        try {
          const result = await shopifyGraphQLRequest(bulkVariantMutation, {});
          
          // Check for errors in any of the variant resets
          for (let i = 0; i < variantBatch.length; i++) {
            const variantResult = result.data?.[`variant${i}`];
            if (variantResult?.userErrors?.length > 0) {
              console.error(`Variant ${variantBatch[i].id} reset failed:`, variantResult.userErrors);
            }
          }
          
          console.log(`✅ Completed reset batch ${batchIndex + 1}/${variantBatches.length}`);
          return { success: true, count: variantBatch.length };
        } catch (error) {
          console.error(`❌ Error in reset batch ${batchIndex + 1}:`, error);
          
          // Fallback to individual variant resets for this batch
          console.log(`🔄 Falling back to individual resets for batch ${batchIndex + 1}`);
          const individualPromises = variantBatch.map(async variant => {
            try {
              const singleVariantMutation = `
                mutation updateProductVariant($input: ProductVariantInput!) {
                  productVariantUpdate(input: $input) {
                    productVariant { id price }
                    userErrors { field message }
                  }
                }
              `;
              
              await shopifyGraphQLRequest(singleVariantMutation, {
              input: {
                id: variant.id,
                price: variant.price,
                compareAtPrice: variant.compareAtPrice
              }
              });
              
              return { success: true };
            } catch (err) {
              console.error(`Individual variant reset failed for ${variant.id}:`, err);
              return { success: false };
            }
          });
          
          const individualResults = await Promise.all(individualPromises);
          const successCount = individualResults.filter(r => r.success).length;
          console.log(`🔄 Fallback completed: ${successCount}/${variantBatch.length} variants reset`);
          
          return { success: true, count: successCount };
        }
      });
      
      // Add delay between batches to avoid throttling
      if (batchIndex < variantBatches.length - 1) {
        console.log('⏱️  Waiting 1.5s between variant batches to avoid throttling...');
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    // BULK PRODUCT TAG UPDATES: Remove discount tags
    const productBatches = [];
    for (let i = 0; i < productTagUpdates.length; i += BATCH_SIZE) {
      productBatches.push(productTagUpdates.slice(i, i + BATCH_SIZE));
    }

    console.log(`🏷️  Processing ${productTagUpdates.length} product tag removals in ${productBatches.length} bulk operations`);

    // Process product tag updates sequentially with delays
    for (let batchIndex = 0; batchIndex < productBatches.length; batchIndex++) {
      const productBatch = productBatches[batchIndex];
      
      await runWithConcurrencyLimit(async () => {
        console.log(`🏷️  Processing product reset batch ${batchIndex + 1}/${productBatches.length} (${productBatch.length} products)`);
        
        // Use bulk mutation for multiple products
        const bulkProductMutation = `
          mutation bulkProductTagReset {
            ${productBatch.map((product, index) => `
              product${index}: productUpdate(product: {
                id: "${product.id}"
                tags: "${product.tags}"
              }) {
                product {
                  id
                  title
                }
                userErrors {
                  field
                  message
                }
              }
            `).join('\n')}
          }
        `;

        try {
          const result = await shopifyGraphQLRequest(bulkProductMutation, {});
          
          // Check for errors in any of the product updates
          for (let i = 0; i < productBatch.length; i++) {
            const productResult = result.data?.[`product${i}`];
            if (productResult?.userErrors?.length > 0) {
              console.error(`Product ${productBatch[i].id} tag reset failed:`, productResult.userErrors);
            }
          }
          
          console.log(`✅ Completed product reset batch ${batchIndex + 1}/${productBatches.length}`);
          return { success: true, count: productBatch.length };
        } catch (error) {
          console.error(`❌ Error in product reset batch ${batchIndex + 1}:`, error);
          return { success: false, count: 0 };
        }
      });
      
      // Add delay between product tag batches to avoid throttling
      if (batchIndex < productBatches.length - 1) {
        console.log('⏱️  Waiting 1.5s between product tag batches to avoid throttling...');
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    console.log(`✅ All bulk reset operations completed sequentially to avoid throttling`);

    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`🎉 THROTTLE-SAFE BULK RESET COMPLETED!`);
    console.log(`⏱️  Total time: ${duration}ms (${(duration/1000).toFixed(2)}s)`);
    console.log(`📊 Processed: ${productTagUpdates.length} products, ${allVariantUpdates.length} variants`);
    console.log(`🚦 Used conservative rate limiting to avoid Shopify throttling`);

    // Performance improvement note
    if (duration < 30000) { // Less than 30 seconds
      console.log(`🚀 SPEED IMPROVEMENT: Reset completed in under 30 seconds!`);
    } else if (duration < 60000) { // Less than 1 minute
      console.log(`⚡ SPEED IMPROVEMENT: Reset completed in under 1 minute!`);
    }

    } catch (error) {
    console.error(`❌ Critical error in bulk reset operations:`, error);
    
    // Fallback to original method if bulk operations fail completely
    console.log(`🔄 Falling back to original reset method...`);
    return await resetAllProductPricesOriginal();
  }
  
  console.log('🏁 OPTIMIZED: Finished resetting all product prices');
}

// Keep the original reset function as a fallback
async function resetAllProductPricesOriginal() {
  console.log(`🔄 FALLBACK: Using original price reset method`);
  
  const validProducts = globalAuctionState.products.filter(p => p && p.variants && p.variants.length > 0);
  
  if (validProducts.length === 0) {
    console.log('No valid products to reset prices for.');
    return;
  }
  
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 500;
  
  const batches = [];
  for (let i = 0; i < validProducts.length; i += BATCH_SIZE) {
    batches.push(validProducts.slice(i, i + BATCH_SIZE));
  }
  
  for (const [index, batch] of batches.entries()) {
    console.log(`Processing fallback reset batch ${index + 1}/${batches.length}`);
    
    const updatePromises = batch.map(async (product) => {
      try {
        const rawProductId = (product.id || '').toString().replace(/\.0$/, '');
        const productId = rawProductId.includes('gid://') ? rawProductId : `gid://shopify/Product/${rawProductId}`;
        
        const tagList = product.tags ? (typeof product.tags === 'string' ? product.tags.split(', ') : []) : [];
        const filteredTags = tagList.filter(tag => !tag.startsWith('discount:'));
        
        // Update product tags
        const productMutation = `
          mutation updateProduct($product: ProductInput!) {
            productUpdate(product: $product) {
              product { id title }
              userErrors { field message }
            }
          }
        `;
        
        await shopifyGraphQLRequest(productMutation, {
          product: { id: productId, tags: filteredTags.join(', ') }
        });
        
        // Reset variants
        const variantPromises = (product.variants || []).map(async variant => {
          let variantId;
          let compareAtPrice;
          
          if (variant.admin_graphql_api_id) {
            variantId = variant.admin_graphql_api_id;
            compareAtPrice = variant.compare_at_price || variant.price;
          } else {
            const rawVariantId = (variant.id || '').toString().replace(/\.0$/, '');
            variantId = rawVariantId.includes('gid://') ? rawVariantId : `gid://shopify/ProductVariant/${rawVariantId}`;
            compareAtPrice = variant.compare_at_price || variant.price;
          }
          
          const variantMutation = `
            mutation updateProductVariant($input: ProductVariantInput!) {
              productVariantUpdate(input: $input) {
                productVariant { id price }
                userErrors { field message }
              }
            }
          `;
          
          await shopifyGraphQLRequest(variantMutation, {
            input: {
              id: variantId,
              price: compareAtPrice,
              compareAtPrice: compareAtPrice
            }
          });
        });
        
        await Promise.all(variantPromises);
        return { success: true };
      } catch (error) {
        console.error(`Error resetting product ${product.id}:`, error);
        return { success: false };
      }
    });
    
    await Promise.all(updatePromises);
    
    if (index < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
}

// New function to initialize scheduled auctions on server startup
async function initScheduledAuctions() {
  console.log('Initializing scheduled auctions...');
  
  try {
    // Get all scheduled auctions from the database
    const scheduledAuctions = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM auctions WHERE is_active = 0 AND scheduled_start IS NOT NULL', 
        (err, rows) => {
          if (err) {
            console.error('Error fetching scheduled auctions:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
    
    if (scheduledAuctions.length === 0) {
      console.log('No scheduled auctions found in database.');
      return;
    }
    
    console.log(`Found ${scheduledAuctions.length} scheduled auctions in database.`);
    
    // For now we only support a single global auction
    const globalAuction = scheduledAuctions.find(a => a.product_id === 'global');
    
    if (!globalAuction) {
      console.log('No global auction found among scheduled auctions.');
      return;
    }
    
    console.log('=======================================================');
    console.log('SCHEDULED AUCTION FOUND:');
    console.log('ID:', globalAuction.id);
    console.log('Scheduled Start:', globalAuction.scheduled_start);
    console.log('Timezone:', globalAuction.timezone);
    console.log('Interval:', globalAuction.interval_minutes, 'minutes');
    console.log('Starting Discount:', globalAuction.reduction_percent, '%');
    console.log('=======================================================');
    
    // Check if the scheduled start time is valid
    const scheduledStartTime = new Date(globalAuction.scheduled_start);
    if (isNaN(scheduledStartTime.getTime())) {
      console.error('Invalid scheduled start time:', globalAuction.scheduled_start);
      return;
    }
    
    // Check if the scheduled time is in the future
    const now = new Date();
    if (scheduledStartTime <= now) {
      console.log('Scheduled time is in the past, auction should have already started.');
      console.log('Current time:', now.toISOString());
      console.log('Scheduled time:', scheduledStartTime.toISOString());
      
      // We'll let the scheduler job handle this on its next run
      return;
    }
    
    // Update the global auction state
    globalAuctionState.isRunning = false;
    globalAuctionState.scheduledStartTime = scheduledStartTime;
    globalAuctionState.timezone = globalAuction.timezone || 'CET';
    globalAuctionState.intervalMinutes = parseInt(globalAuction.interval_minutes) || 1;
    globalAuctionState.startingDiscountPercent = parseInt(globalAuction.reduction_percent) || 5;
    globalAuctionState.currentDiscountPercent = 0;
    
    // Calculate time until the auction starts
    const timeUntilStart = scheduledStartTime - now;
    const minutesUntilStart = Math.floor(timeUntilStart / 60000);
    const secondsUntilStart = Math.floor((timeUntilStart % 60000) / 1000);
    
    console.log(`Auction will start in ${minutesUntilStart} minutes and ${secondsUntilStart} seconds.`);
    console.log(`Scheduled start time (ISO): ${scheduledStartTime.toISOString()}`);
    
    // Format in the specified timezone
    const formattedTime = moment(scheduledStartTime).tz(globalAuction.timezone || 'CET').format('YYYY-MM-DD HH:mm:ss');
    console.log(`Scheduled start time (${globalAuction.timezone || 'CET'}): ${formattedTime}`);
    
    console.log('Auction has been initialized in memory and will start automatically.');
    console.log('=======================================================');
  } catch (error) {
    console.error('Error initializing scheduled auctions:', error);
  }
}

// Add timezone awareness to the scheduled job
schedule.scheduleJob('* * * * *', async () => {
  const now = new Date();
  const formattedNow = now.toISOString();
  
  try {
    console.log('=======================================================');
    console.log(`SCHEDULER: Running scheduled job at: ${formattedNow}`);
    console.log('=======================================================');
    
    // First check the database for any scheduled auctions that should be started
    try {
      console.log(`SCHEDULER: Checking database for scheduled auctions at ${formattedNow}`);
      const scheduledAuctions = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM auctions WHERE is_active = 0 AND scheduled_start IS NOT NULL', (err, rows) => {
          if (err) {
            console.error('SCHEDULER: Error fetching scheduled auctions from database:', err);
            reject(err);
          } else {
            console.log(`SCHEDULER: Database returned ${rows.length} scheduled auctions`);
            resolve(rows || []);
          }
        });
      });
      
      // Log all database auctions for debugging
      db.all('SELECT id, product_id, is_active, scheduled_start, reduction_percent FROM auctions', (err, allAuctions) => {
        if (!err && allAuctions) {
          console.log(`SCHEDULER: Total auctions in database: ${allAuctions.length}`);
          allAuctions.forEach(a => {
            console.log(`SCHEDULER: Auction #${a.id} - Product: ${a.product_id}, Active: ${a.is_active}, Scheduled: ${a.scheduled_start || 'None'}, Reduction: ${a.reduction_percent}%`);
          });
        }
      });
      
      if (scheduledAuctions.length > 0) {
        console.log(`!!! FOUND ${scheduledAuctions.length} SCHEDULED AUCTIONS IN DATABASE !!!`);
        console.log('=======================================================');
        
        // Log each scheduled auction for debugging
        scheduledAuctions.forEach((auction, index) => {
          const scheduledStartTime = new Date(auction.scheduled_start);
          const diffMs = scheduledStartTime - now;
          const diffMins = Math.floor(diffMs / 60000);
          const diffSecs = Math.floor((diffMs % 60000) / 1000);
          
          console.log(`!!! SCHEDULED AUCTION #${auction.id} DETAILS !!!`);
          console.log(`ID: ${auction.id}`);
          console.log(`Product ID: ${auction.product_id}`);
          console.log(`Scheduled start: ${auction.scheduled_start}`);
          console.log(`Timezone: ${auction.timezone || 'CET'}`);
          console.log(`Interval minutes: ${auction.interval_minutes}`);
          console.log(`Reduction percent: ${auction.reduction_percent}`);
          console.log(`Status: ${diffMs > 0 ? 'Pending' : 'Due to start'}`);
          console.log(`Time remaining: ${diffMs > 0 ? `${diffMins}m ${diffSecs}s` : 'In the past'}`);
          console.log('=======================================================');
        });
        
        // Process each scheduled auction - check if any need to start
        for (const auction of scheduledAuctions) {
          const scheduledStartTime = new Date(auction.scheduled_start);
          
          // Check if this auction should be started now
          if (!isNaN(scheduledStartTime.getTime()) && scheduledStartTime <= now) {
            console.log('!!! ATTENTION: SCHEDULED AUCTION IS DUE TO START !!!');
            console.log(`SCHEDULER: Starting scheduled auction #${auction.id}!`);
            console.log(`Scheduled time: ${scheduledStartTime.toISOString()}`);
            console.log(`Current time: ${now.toISOString()}`);
            
            try {
              // Update the database first - mark as active
              await new Promise((resolve, reject) => {
                db.run(
                  'UPDATE auctions SET is_active = 1 WHERE id = ?',
                  [auction.id],
                  (err) => {
                    if (err) {
                      console.error(`SCHEDULER: Error activating auction #${auction.id}:`, err);
                      reject(err);
                    } else {
                      console.log(`SCHEDULER: Successfully activated auction #${auction.id} in database`);
                      resolve();
                    }
                  }
                );
              });
              
              // Set global state to reflect the auction is now running
              if (auction.product_id === 'global') {
                console.log('SCHEDULER: This is a global auction, updating global state');
                
                // NEW LOGIC: Keep existing discount at auction start, don't add to it
                const existingDiscountPercent = globalAuctionState.currentDiscountPercent || 0;
                const startingDiscountIncrement = parseInt(auction.reduction_percent) || 5;
                
                let schedulerStartingDiscountPercent;
                if (existingDiscountPercent > 0) {
                  // Keep the existing discount as-is (e.g., manual 10% stays 10%)
                  schedulerStartingDiscountPercent = existingDiscountPercent;
                  console.log(`🎯 SCHEDULER: Keeping existing ${existingDiscountPercent}% discount at auction start`);
                } else {
                  // No existing discount, start with first increment
                  schedulerStartingDiscountPercent = startingDiscountIncrement;
                  console.log(`🆕 SCHEDULER: Starting fresh with ${schedulerStartingDiscountPercent}%`);
                }
                
                // Update the global auction state
                globalAuctionState.isRunning = true;
                globalAuctionState.startedAt = new Date(auction.scheduled_start);
                globalAuctionState.scheduledStartTime = null; // Clear scheduled time since it's now running
                globalAuctionState.lastUpdateTime = now;
                globalAuctionState.currentDiscountPercent = schedulerStartingDiscountPercent;
                globalAuctionState.intervalMinutes = parseInt(auction.interval_minutes) || 1;
                
                // If we don't have products loaded yet, fetch them
                if (globalAuctionState.products.length === 0) {
                  console.log('SCHEDULER: No products in memory, fetching all products');
                  try {
                    const products = await fetchAllProducts();
                    globalAuctionState.products = products.filter(p => p.variants && p.variants.length > 0);
                    console.log(`SCHEDULER: Loaded ${globalAuctionState.products.length} products for auction`);
                  } catch (error) {
                    console.error('SCHEDULER: Error fetching products:', error);
                  }
                }
                
                // Apply the initial discount
                try {
                  console.log(`SCHEDULER: Applying initial discount of ${globalAuctionState.currentDiscountPercent}%`);
                  await updateAllProductPrices(globalAuctionState.currentDiscountPercent);
                  console.log('SCHEDULER: Initial discounts applied successfully');
                } catch (error) {
                  console.error('SCHEDULER: Error applying initial discounts:', error);
                }
                
                // Set the next update time
                const nextUpdate = new Date();
                nextUpdate.setMinutes(nextUpdate.getMinutes() + globalAuctionState.intervalMinutes);
                
                // Update the database with the next update time
                try {
                  await new Promise((resolve, reject) => {
                    db.run(
                      'UPDATE auctions SET next_update = ? WHERE id = ?',
                      [nextUpdate.toISOString().replace('T', ' ').split('.')[0], auction.id],
                      (err) => {
                        if (err) {
                          console.error('SCHEDULER: Error updating next_update time:', err);
                          reject(err);
                        } else {
                          console.log(`SCHEDULER: Next update time set to ${nextUpdate.toISOString()}`);
                          resolve();
                        }
                      }
                    );
                  });
                  
                  console.log('!!! AUCTION HAS BEEN STARTED SUCCESSFULLY !!!');
                } catch (error) {
                  console.error('SCHEDULER: Error updating next update time:', error);
                }
              }
            } catch (error) {
              console.error(`SCHEDULER: Error starting auction #${auction.id}:`, error);
            }
          } else if (!isNaN(scheduledStartTime.getTime())) {
            // This auction is still scheduled for the future
            const diffMs = scheduledStartTime - now;
            const diffMins = Math.floor(diffMs / 60000);
            const diffSecs = Math.floor((diffMs % 60000) / 1000);
            
            console.log(`SCHEDULER: Auction #${auction.id} scheduled to start in ${diffMins}m ${diffSecs}s`);
          } else {
            console.error(`SCHEDULER: Auction #${auction.id} has invalid scheduled_start: ${auction.scheduled_start}`);
          }
        }
      } else {
        console.log('SCHEDULER: No scheduled auctions found in database');
        
        // ... existing code ...
      }
    } catch (error) {
      console.error('SCHEDULER: Error checking scheduled auctions:', error);
    }
    
    // ... existing code to check if running auction needs price updates ...
    console.log('SCHEDULER: Current globalAuctionState:');
    console.log('- isRunning:', globalAuctionState.isRunning);
    console.log('- scheduledStartTime:', globalAuctionState.scheduledStartTime ? globalAuctionState.scheduledStartTime.toISOString() : 'null');
    console.log('- timezone:', globalAuctionState.timezone);
    console.log('- intervalMinutes:', globalAuctionState.intervalMinutes);
    console.log('- startingDiscountPercent:', globalAuctionState.startingDiscountPercent);
    console.log('- currentDiscountPercent:', globalAuctionState.currentDiscountPercent);
    
    // Now check if running auction needs a price update - FIXED TIMING
    if (globalAuctionState.isRunning) {
      console.log('SCHEDULER: Checking if auction price update is due...');
      
      const startTime = globalAuctionState.startedAt || globalAuctionState.scheduledStartTime;
      const intervalMs = globalAuctionState.intervalMinutes * 60 * 1000;
      
      if (!startTime) {
        console.log('SCHEDULER: No start time found, cannot determine update schedule');
        return;
      }
      
      // Calculate how many intervals should have passed since start
      const elapsedMs = now - startTime;
      const intervalsPassed = Math.floor(elapsedMs / intervalMs);
      const nextIntervalNumber = intervalsPassed + 1;
      
      // Calculate the exact time for the next update (based on start time + intervals)
      const nextScheduledUpdate = new Date(startTime.getTime() + (nextIntervalNumber * intervalMs));
      const currentScheduledUpdate = new Date(startTime.getTime() + (intervalsPassed * intervalMs));
      
      console.log(`SCHEDULER: Start time: ${startTime.toISOString()}`);
      console.log(`SCHEDULER: Elapsed time: ${Math.floor(elapsedMs / 60000)}m ${Math.floor((elapsedMs % 60000) / 1000)}s`);
      console.log(`SCHEDULER: Intervals passed: ${intervalsPassed}`);
      console.log(`SCHEDULER: Current scheduled update was at: ${currentScheduledUpdate.toISOString()}`);
      console.log(`SCHEDULER: Next scheduled update is at: ${nextScheduledUpdate.toISOString()}`);
      
      // Check if we've passed a scheduled update time and haven't processed it yet
      // Calculate expected discount for intervals that should have happened
      const expectedDiscountPercent = globalAuctionState.startingDiscountPercent + (intervalsPassed * globalAuctionState.startingDiscountPercent);
      
      // Check if it's time for the next price update
      if (now >= nextScheduledUpdate) {
        console.log('!!! SCHEDULED PRICE UPDATE DUE !!!');
        
        // Calculate the new discount level
        const newDiscountPercent = Math.min(globalAuctionState.currentDiscountPercent + globalAuctionState.startingDiscountPercent, 100);
        
        console.log(`SCHEDULER: Updating discount from ${globalAuctionState.currentDiscountPercent}% to ${newDiscountPercent}%`);
        
        // Set the new discount level
        globalAuctionState.currentDiscountPercent = newDiscountPercent;
        globalAuctionState.lastUpdateTime = now;
        
        console.log(`SCHEDULER: Setting discount to ${globalAuctionState.currentDiscountPercent}% (interval ${intervalsPassed + 1})`);
        
        // Apply the new discount
        await updateAllProductPrices(globalAuctionState.currentDiscountPercent);
        
        // Calculate the NEXT update time (after the one we just processed)
        const followingUpdateTime = new Date(startTime.getTime() + ((intervalsPassed + 2) * intervalMs));
        
        // Update the database with the following scheduled time
        await new Promise((resolve, reject) => {
          db.run(
            'UPDATE auctions SET reduction_percent = ?, current_price = ?, next_update = ? WHERE product_id = ?',
            [
              globalAuctionState.currentDiscountPercent, 
              globalAuctionState.currentDiscountPercent,
              followingUpdateTime.toISOString().replace('T', ' ').split('.')[0], 
              'global'
            ],
            (err) => {
              if (err) {
                console.error('SCHEDULER: Error updating next auction time:', err);
                reject(err);
              } else {
                resolve();
              }
            }
          );
        });
        
        console.log(`SCHEDULER: Next update scheduled for EXACT time: ${followingUpdateTime.toISOString()}`);
      } else {
        const timeToNextUpdate = nextScheduledUpdate - now;
        const minutesRemaining = Math.floor(timeToNextUpdate / 60000);
        const secondsRemaining = Math.floor((timeToNextUpdate % 60000) / 1000);
        
        console.log(`SCHEDULER: Next price update at EXACT time: ${nextScheduledUpdate.toISOString()}`);
        console.log(`SCHEDULER: Time remaining: ${minutesRemaining}m ${secondsRemaining}s`);
      }
    } else {
      console.log('SCHEDULER: No active auction running, skipping price update check');
    }
    
    console.log('=======================================================');
  } catch (error) {
    console.error('SCHEDULER: Error in auction update:', error);
    console.error('SCHEDULER: Stack trace:', error.stack);
    console.log('=======================================================');
  }
});

// Routes
app.get('/', async (req, res) => {
  try {
    console.log('Fetching products...');
    const products = await fetchAllProducts();
    console.log(`Showing ${products.length} products in frontend`);
    
    const auctions = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM auctions WHERE is_active = 1', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.render('index', { 
      products: products || [], 
      auctions,
      error: req.query.error || null,
      message: req.query.message || null
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.render('index', { 
      products: [], 
      auctions: [], 
      error: error.message,
      message: null
    });
  }
});

app.post('/set-compare-prices', async (req, res) => {
  try {
    console.log('🏷️ Setting compare-at prices for all products...');
    
    // Fetch all products if they're not already loaded
    let products;
    if (globalAuctionState.products && globalAuctionState.products.length > 0) {
      products = globalAuctionState.products;
      console.log(`📦 Using cached products: ${products.length}`);
    } else {
      console.log('📦 Fetching fresh product data...');
      products = await fetchAllProducts();
    }
    
    if (!products || products.length === 0) {
      console.log('❌ No products found.');
      return res.redirect('/?error=No products found');
    }
    
    // Filter for products that have variants to update
    const validProducts = [];
    for (const product of products) {
      if (!product.variants || !Array.isArray(product.variants)) continue;
      
      const hasVariantsNeedingUpdate = product.variants.some(variant => {
        return !variant.compare_at_price || variant.compare_at_price === "0.00" || parseFloat(variant.compare_at_price) === 0;
      });
      
      if (hasVariantsNeedingUpdate) {
        validProducts.push(product);
      }
    }
    
    console.log(`✅ Found ${validProducts.length} products with variants needing compare-at price updates`);
    
    if (validProducts.length === 0) {
      console.log('✨ All products already have compare-at prices set.');
      return res.redirect('/?message=All products already have compare-at prices set');
    }
    
    // Use same batching strategy as other functions
    const BATCH_SIZE = 8;
    const VARIANT_BATCH_SIZE = 20;
    const BATCH_DELAY_MS = 1500;
    const MAX_CONCURRENT_REQUESTS = 2;
    
    let totalVariantsUpdated = 0;
    const startTime = Date.now();
    
    // Process products in batches
    for (let i = 0; i < validProducts.length; i += BATCH_SIZE) {
      const batch = validProducts.slice(i, i + BATCH_SIZE);
      console.log(`🔄 Processing product batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(validProducts.length/BATCH_SIZE)} (${batch.length} products)`);
      
      // Process each product in the batch
      for (const product of batch) {
        try {
          const variantsToUpdate = [];
          
          // Collect variants that need compare-at price updates
          for (const variant of product.variants) {
            // Skip if compare-at price is already set
            if (variant.compare_at_price && variant.compare_at_price !== "0.00" && parseFloat(variant.compare_at_price) > 0) {
              continue;
            }
            
            // Skip if price is 0 or invalid
            if (!variant.price || parseFloat(variant.price) <= 0) {
              continue;
            }
            
            variantsToUpdate.push({
              id: variant.admin_graphql_api_id,
              currentPrice: variant.price,
              newCompareAtPrice: variant.price
            });
          }
          
          if (variantsToUpdate.length === 0) {
            continue;
          }
          
          console.log(`🏷️ Updating ${variantsToUpdate.length} variants for product ${product.id}`);
          
          // Process variants in smaller batches using bulk API
          for (let j = 0; j < variantsToUpdate.length; j += VARIANT_BATCH_SIZE) {
            const variantBatch = variantsToUpdate.slice(j, j + VARIANT_BATCH_SIZE);
            
            const bulkVariantMutation = `
              mutation {
                ${variantBatch.map((variant, index) => 
                  `variant${index}: productVariantUpdate(input: {
                    id: "${variant.id}"
                    compareAtPrice: "${variant.newCompareAtPrice}"
                  }) {
                    productVariant {
                      id
                      price
                      compareAtPrice
                    }
                    userErrors {
                      field
                      message
                    }
                  }`
                ).join('\n')}
              }
            `;
            
            const result = await shopifyGraphQLRequest(bulkVariantMutation);
            
            if (result.errors) {
              console.error('❌ GraphQL errors:', result.errors);
              throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
            }
            
            // Check for user errors in each variant update
            for (let k = 0; k < variantBatch.length; k++) {
              const variantResult = result.data[`variant${k}`];
              if (variantResult?.userErrors?.length > 0) {
                console.error(`❌ Variant ${variantBatch[k].id} update failed:`, variantResult.userErrors);
              } else {
                totalVariantsUpdated++;
                console.log(`✅ Set compare-at price for variant ${variantBatch[k].id}: ${variantBatch[k].newCompareAtPrice}`);
              }
            }
            
            // Small delay between variant batches
            if (j + VARIANT_BATCH_SIZE < variantsToUpdate.length) {
              await new Promise(resolve => setTimeout(resolve, 200));
            }
          }
          
        } catch (error) {
          console.error(`❌ Error updating compare-at prices for product ${product.id}:`, error);
        }
      }
      
      // Delay between product batches
      if (i + BATCH_SIZE < validProducts.length) {
        console.log(`⏳ Waiting ${BATCH_DELAY_MS}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`🎉 Successfully set compare-at prices for ${totalVariantsUpdated} variants in ${duration}s`);
    
    res.redirect(`/?message=Compare-at prices set successfully for ${totalVariantsUpdated} variants`);
  } catch (error) {
    console.error('❌ Error setting compare prices:', error);
    res.redirect('/?error=Error setting compare-at prices');
  }
});

// OLD /revert-all-prices endpoint removed - now using /reset-all-prices instead

app.post('/auctions', async (req, res) => {
  console.log('Form data received:', req.body);
  const { productId, interval, reductionPercent } = req.body;
  
  if (!productId) {
    console.error('No product ID provided');
    return res.status(400).send('Product ID is required');
  }

  try {
    console.log('Creating auction for product:', productId);
    const response = await shopifyRequest(`products/${productId}.json`);
    
    if (!response.product || !response.product.variants || !response.product.variants[0]) {
      console.error('Invalid product data:', response);
      return res.status(400).send('Invalid product data');
    }

    const originalPrice = parseFloat(response.product.variants[0].price);
    const nextUpdate = new Date();
    nextUpdate.setMinutes(nextUpdate.getMinutes() + parseInt(interval));

    db.run(
      'INSERT INTO auctions (product_id, original_price, current_price, interval_minutes, reduction_percent, next_update) VALUES (?, ?, ?, ?, ?, ?)',
      [productId, originalPrice, originalPrice, interval, reductionPercent, nextUpdate.toISOString().replace('T', ' ').split('.')[0]],
      (err) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).send('Error creating auction');
        }
        res.redirect('/');
      }
    );
  } catch (error) {
    console.error('Error creating auction:', error);
    res.status(500).send('Error creating auction');
  }
});

app.post('/auctions/:id/delete', async (req, res) => {
  const { id } = req.params;
  try {
    await deactivateAuction(id);
    res.redirect('/');
  } catch (error) {
    console.error('Error deleting auction:', error);
    res.status(500).send('Error deleting auction');
  }
});

// Auction status API endpoint for storefront timers - updated with timezone support
app.get('/api/auction-status', (req, res) => {
  console.log('!!! API: /api/auction-status requested !!!');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Request from: ${req.headers['user-agent'] || 'Unknown'}`);
  console.log('Auction status API called from:', req.headers.origin);
  
  // Check for scheduled start time
  if (!globalAuctionState.isRunning && globalAuctionState.scheduledStartTime) {
    const now = new Date();
    if (now >= globalAuctionState.scheduledStartTime) {
      // Time to start the auction
      console.log('Starting scheduled auction now');
      
      // NEW LOGIC: Keep existing discount at auction start (don't add to it)
      const existingDiscountPercent = globalAuctionState.currentDiscountPercent || 0;
      const startingDiscountIncrement = globalAuctionState.startingDiscountPercent;
      
      let auctionStartingDiscountPercent;
      if (existingDiscountPercent > 0) {
        // Keep existing discount (e.g., manual 10% stays 10%)
        auctionStartingDiscountPercent = existingDiscountPercent;
        console.log(`🎯 API: Keeping existing ${existingDiscountPercent}% discount at auction start`);
      } else {
        // No existing discount, start with first increment
        auctionStartingDiscountPercent = startingDiscountIncrement;
        console.log(`🆕 API: Starting fresh with ${auctionStartingDiscountPercent}%`);
      }
      
      globalAuctionState.isRunning = true;
      globalAuctionState.startedAt = globalAuctionState.scheduledStartTime;
      globalAuctionState.lastUpdateTime = now;
      globalAuctionState.currentDiscountPercent = auctionStartingDiscountPercent;
      
      // Start the auction by updating prices
      updateAllProductPrices(globalAuctionState.currentDiscountPercent)
        .then(() => {
          console.log('Scheduled auction started successfully');
          
          // Update the auction record to active
          db.run(
            'UPDATE auctions SET is_active = 1, current_price = ? WHERE product_id = ?',
            [globalAuctionState.currentDiscountPercent, 'global'],
            (err) => {
              if (err) console.error('Error updating auction record:', err);
            }
          );
        })
        .catch(err => {
          console.error('Error starting scheduled auction:', err);
        });
    }
  }
  
  // Check if auction is running
  if (!globalAuctionState.isRunning && !globalAuctionState.scheduledStartTime) {
    console.log('No active auction running');
    return res.json({
      isRunning: false,
      message: 'No auction is currently running'
    });
  }
  
  // Get the next update time from database for accuracy
  db.get('SELECT * FROM auctions WHERE product_id = ?', ['global'], async (err, auction) => {
    if (err || !auction) {
      console.log('No auction found in database, using memory state');
      // If there's an error or no auction found, use the memory state as fallback
      
      let now = new Date();
      let nextUpdate;
      let timeUntilNextUpdate;
      
      if (globalAuctionState.isRunning) {
        // Auction is running, calculate next update time based on original start time
        const startTime = globalAuctionState.startedAt;
        const intervalMs = globalAuctionState.intervalMinutes * 60 * 1000;
        const elapsedMs = Math.max(0, now - startTime);
        const intervalsPassed = Math.floor(elapsedMs / intervalMs);
        const nextIntervalNumber = intervalsPassed + 1;
        
        // Calculate next update based on original start time + intervals
        nextUpdate = new Date(startTime.getTime() + (nextIntervalNumber * intervalMs));
        timeUntilNextUpdate = Math.max(0, nextUpdate - now);
      } else if (globalAuctionState.scheduledStartTime) {
        // Auction is scheduled but not started yet
        nextUpdate = new Date(globalAuctionState.scheduledStartTime);
        timeUntilNextUpdate = Math.max(0, nextUpdate - now);
        console.log(`Auction is scheduled to start at ${nextUpdate.toISOString()}`);
        console.log(`Time until start: ${timeUntilNextUpdate}ms`);
      }
      
      // Calculate future price drop schedule for fallback
      const schedule = [];
      if (globalAuctionState.isRunning || globalAuctionState.scheduledStartTime) {
        const startTime = globalAuctionState.startedAt || globalAuctionState.scheduledStartTime;
        const intervalMs = globalAuctionState.intervalMinutes * 60 * 1000;
        const discountIncrement = globalAuctionState.startingDiscountPercent;
        const currentDiscountPercent = globalAuctionState.currentDiscountPercent || 0;
        const now = new Date();
        
        // Calculate how many intervals should have passed since start
        const elapsedMs = Math.max(0, now - startTime);
        const intervalsPassed = Math.floor(elapsedMs / intervalMs);
        
        // Generate schedule until 100% discount
        const maxIntervals = Math.ceil((100 - currentDiscountPercent) / discountIncrement) + 1; // +1 to include 100%
        const intervalsToShow = Math.min(maxIntervals, 50); // Cap at 50 to prevent excessive data
        
        for (let i = 1; i <= intervalsToShow; i++) {
          let dropTime, discountPercent, intervalNumber;
          
          if (globalAuctionState.isRunning) {
            // For active auctions, calculate from next interval
            intervalNumber = intervalsPassed + i;
            dropTime = new Date(startTime.getTime() + (intervalNumber * intervalMs));
            discountPercent = currentDiscountPercent + (i * discountIncrement);
          } else {
            // For scheduled auctions, show the scheduled start time and subsequent intervals
            if (i === 1) {
              // First entry shows the actual start time (when initial discount is applied)
              dropTime = new Date(startTime.getTime());
              discountPercent = currentDiscountPercent;
            } else {
              // Subsequent intervals after start time
              intervalNumber = i - 1; // Adjust because first drop is at start time
              dropTime = new Date(startTime.getTime() + (intervalNumber * intervalMs));
              discountPercent = currentDiscountPercent + (intervalNumber * discountIncrement);
            }
          }
          
          // Cap discount at 100%
          discountPercent = Math.min(discountPercent, 100);
          
          // Skip if discount would exceed 100%
          if (discountPercent > 100) break;
          
          schedule.push({
            intervalNumber: intervalNumber,
            scheduledTime: dropTime.toISOString(),
            discountPercent: discountPercent,
            formattedTime: moment(dropTime).tz(globalAuctionState.timezone || 'CET').format('HH:mm:ss'),
            formattedDateTime: moment(dropTime).tz(globalAuctionState.timezone || 'CET').format('YYYY-MM-DD HH:mm:ss')
          });
        }
      }
      
      // Calculate detailed timing information for debugging
      const startTime = globalAuctionState.startedAt || globalAuctionState.scheduledStartTime;
      const currentTime = new Date();
      const intervalMs = globalAuctionState.intervalMinutes * 60 * 1000;
      
      let debugInfo = {};
      if (startTime && globalAuctionState.isRunning) {
        const elapsedMs = Math.max(0, currentTime - startTime);
        const intervalsPassed = Math.floor(elapsedMs / intervalMs);
        const nextIntervalNumber = intervalsPassed + 1;
        const nextScheduledUpdate = new Date(startTime.getTime() + (nextIntervalNumber * intervalMs));
        const timeToNextUpdate = Math.max(0, nextScheduledUpdate - currentTime);
        
        debugInfo = {
          startTime: startTime.toISOString(),
          currentTime: currentTime.toISOString(),
          elapsedMs: elapsedMs,
          elapsedMinutes: Math.floor(elapsedMs / 60000),
          elapsedSeconds: Math.floor((elapsedMs % 60000) / 1000),
          intervalMs: intervalMs,
          intervalsPassed: intervalsPassed,
          nextIntervalNumber: nextIntervalNumber,
          nextScheduledUpdate: nextScheduledUpdate.toISOString(),
          timeToNextUpdateMs: timeToNextUpdate,
          timeToNextUpdateMinutes: Math.floor(timeToNextUpdate / 60000),
          timeToNextUpdateSeconds: Math.floor((timeToNextUpdate % 60000) / 1000),
          expectedCurrentDiscount: globalAuctionState.startingDiscountPercent + (intervalsPassed * globalAuctionState.startingDiscountPercent),
          nextDiscountLevel: Math.min(globalAuctionState.currentDiscountPercent + globalAuctionState.startingDiscountPercent, 100),
          shouldUpdateNow: currentTime >= nextScheduledUpdate,
          incrementPerInterval: globalAuctionState.startingDiscountPercent
        };
      }

      return res.json({
        // Basic auction status
        isRunning: globalAuctionState.isRunning,
        isScheduled: !globalAuctionState.isRunning && !!globalAuctionState.scheduledStartTime,
        currentDiscountPercent: globalAuctionState.currentDiscountPercent,
        nextUpdateTime: nextUpdate ? nextUpdate.toISOString() : null,
        timeUntilNextUpdateMs: timeUntilNextUpdate || 0,
        intervalMinutes: globalAuctionState.intervalMinutes,
        startingDiscountPercent: globalAuctionState.currentDiscountPercent,
        scheduledStartTime: globalAuctionState.scheduledStartTime ? globalAuctionState.scheduledStartTime.toISOString() : null,
        timezone: globalAuctionState.timezone || 'CET',
        schedule: schedule,
        
        // NEW: Detailed debug information
        debug: debugInfo,
        
        // NEW: Global auction state snapshot
        globalState: {
          isRunning: globalAuctionState.isRunning,
          startedAt: globalAuctionState.startedAt ? globalAuctionState.startedAt.toISOString() : null,
          scheduledStartTime: globalAuctionState.scheduledStartTime ? globalAuctionState.scheduledStartTime.toISOString() : null,
          lastUpdateTime: globalAuctionState.lastUpdateTime ? globalAuctionState.lastUpdateTime.toISOString() : null,
          timezone: globalAuctionState.timezone,
          intervalMinutes: globalAuctionState.intervalMinutes,
          startingDiscountPercent: globalAuctionState.startingDiscountPercent,
          currentDiscountPercent: globalAuctionState.currentDiscountPercent,
          productsCount: globalAuctionState.products ? globalAuctionState.products.length : 0
        },
        
        // NEW: Server timing information
        serverInfo: {
          timestamp: currentTime.toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          uptime: process.uptime(),
          schedulerStatus: 'active' // Scheduler always runs every minute
        }
      });
    }
    
    // If auction found in DB, use that data
    const now = new Date();
    const isScheduled = !auction.is_active && auction.scheduled_start;
    
    let nextUpdate;
    let timeUntilNextUpdate;
    
    if (auction.is_active) {
      // Active auction
      nextUpdate = new Date(auction.next_update);
      timeUntilNextUpdate = Math.max(0, nextUpdate - now);
    } else if (isScheduled) {
      // Scheduled auction
      nextUpdate = new Date(auction.scheduled_start);
      timeUntilNextUpdate = Math.max(0, nextUpdate - now);
      console.log(`DB: Auction is scheduled to start at ${nextUpdate.toISOString()}`);
      console.log(`DB: Time until start: ${timeUntilNextUpdate}ms`);
    }
    
    console.log('Sending auction data:', {
      isRunning: !!auction.is_active,
      isScheduled: isScheduled,
      discountPercent: auction.reduction_percent,
      nextUpdate: nextUpdate ? nextUpdate.toISOString() : null,
      timeUntil: timeUntilNextUpdate || 0,
      timezone: auction.timezone || 'CET'
    });
    
    // Format the scheduled time in the correct timezone for display
    let formattedScheduledTime = null;
    if (auction.scheduled_start) {
      formattedScheduledTime = moment(auction.scheduled_start)
        .tz(auction.timezone || 'CET')
        .format('YYYY-MM-DD HH:mm:ss');
    }
    
    // Calculate future price drop schedule
    const schedule = [];
    if (auction.is_active || isScheduled) {
      const startTime = auction.is_active 
        ? (globalAuctionState.startedAt || new Date(auction.scheduled_start))
        : new Date(auction.scheduled_start);
      const intervalMs = parseInt(auction.interval_minutes) * 60 * 1000;
      const discountIncrement = globalAuctionState.startingDiscountPercent || 5;
      // FIXED: Use actual current discount from globalAuctionState, not just reduction_percent
      const currentDiscountPercent = globalAuctionState.currentDiscountPercent || (auction.is_active ? parseInt(auction.reduction_percent) : 0);
      const now = new Date();
      
      // Calculate how many intervals should have passed since start
      const elapsedMs = Math.max(0, now - startTime);
      const intervalsPassed = Math.floor(elapsedMs / intervalMs);
      
      // Generate schedule until 100% discount
      const maxIntervals = Math.ceil((100 - currentDiscountPercent) / discountIncrement) + 1; // +1 to include 100%
      const intervalsToShow = Math.min(maxIntervals, 50); // Cap at 50 to prevent excessive data
      
      for (let i = 1; i <= intervalsToShow; i++) {
        let dropTime, discountPercent, intervalNumber;
        
        if (auction.is_active) {
          // For active auctions, calculate from next interval
          intervalNumber = intervalsPassed + i;
          dropTime = new Date(startTime.getTime() + (intervalNumber * intervalMs));
          discountPercent = currentDiscountPercent + (i * discountIncrement);
        } else {
          // For scheduled auctions, show the scheduled start time and subsequent intervals
          if (i === 1) {
            // First entry shows the actual start time (when initial discount is applied)
            dropTime = new Date(startTime.getTime());
            discountPercent = currentDiscountPercent;
          } else {
            // Subsequent intervals after start time
            intervalNumber = i - 1; // Adjust because first drop is at start time
            dropTime = new Date(startTime.getTime() + (intervalNumber * intervalMs));
            discountPercent = currentDiscountPercent + (intervalNumber * discountIncrement);
          }
        }
        
        // Cap discount at 100%
        discountPercent = Math.min(discountPercent, 100);
        
        // Skip if discount would exceed 100%
        if (discountPercent > 100) break;
        
        schedule.push({
          intervalNumber: intervalNumber,
          scheduledTime: dropTime.toISOString(),
          discountPercent: discountPercent,
          formattedTime: moment(dropTime).tz(auction.timezone || 'CET').format('HH:mm:ss'),
          formattedDateTime: moment(dropTime).tz(auction.timezone || 'CET').format('YYYY-MM-DD HH:mm:ss')
        });
      }
    }
    
    // Calculate detailed timing information for debugging (DB version)
    const startTime = auction.is_active 
      ? (globalAuctionState.startedAt || new Date(auction.scheduled_start))
      : new Date(auction.scheduled_start);
    const currentTime = new Date();
    const intervalMs = parseInt(auction.interval_minutes) * 60 * 1000;
    
    let debugInfo = {};
    if (startTime && auction.is_active) {
      const elapsedMs = Math.max(0, currentTime - startTime);
      const intervalsPassed = Math.floor(elapsedMs / intervalMs);
      const nextIntervalNumber = intervalsPassed + 1;
      const nextScheduledUpdate = new Date(startTime.getTime() + (nextIntervalNumber * intervalMs));
      const timeToNextUpdate = Math.max(0, nextScheduledUpdate - currentTime);
      const discountIncrement = globalAuctionState.startingDiscountPercent || parseInt(auction.reduction_percent);
      
      debugInfo = {
        startTime: startTime.toISOString(),
        currentTime: currentTime.toISOString(),
        elapsedMs: elapsedMs,
        elapsedMinutes: Math.floor(elapsedMs / 60000),
        elapsedSeconds: Math.floor((elapsedMs % 60000) / 1000),
        intervalMs: intervalMs,
        intervalsPassed: intervalsPassed,
        nextIntervalNumber: nextIntervalNumber,
        nextScheduledUpdate: nextScheduledUpdate.toISOString(),
        timeToNextUpdateMs: timeToNextUpdate,
        timeToNextUpdateMinutes: Math.floor(timeToNextUpdate / 60000),
        timeToNextUpdateSeconds: Math.floor((timeToNextUpdate % 60000) / 1000),
        expectedCurrentDiscount: discountIncrement + (intervalsPassed * discountIncrement),
        nextDiscountLevel: Math.min((globalAuctionState.currentDiscountPercent || parseInt(auction.reduction_percent)) + discountIncrement, 100),
        shouldUpdateNow: currentTime >= nextScheduledUpdate,
        incrementPerInterval: discountIncrement,
        databaseNextUpdate: auction.next_update,
        databaseReductionPercent: auction.reduction_percent
      };
    }

    res.json({
      // Basic auction status
      isRunning: !!auction.is_active,
      isScheduled: isScheduled,
      currentDiscountPercent: globalAuctionState.currentDiscountPercent || parseInt(auction.reduction_percent),
      nextUpdateTime: nextUpdate ? nextUpdate.toISOString() : null,
      timeUntilNextUpdateMs: timeUntilNextUpdate || 0,
      intervalMinutes: parseInt(auction.interval_minutes),
      startingDiscountPercent: globalAuctionState.currentDiscountPercent || parseInt(auction.reduction_percent),
      scheduledStartTime: auction.scheduled_start ? new Date(auction.scheduled_start).toISOString() : null,
      formattedScheduledTime: formattedScheduledTime,
      timezone: auction.timezone || 'CET',
      schedule: schedule,
      
      // NEW: Detailed debug information
      debug: debugInfo,
      
      // NEW: Global auction state snapshot
      globalState: {
        isRunning: globalAuctionState.isRunning,
        startedAt: globalAuctionState.startedAt ? globalAuctionState.startedAt.toISOString() : null,
        scheduledStartTime: globalAuctionState.scheduledStartTime ? globalAuctionState.scheduledStartTime.toISOString() : null,
        lastUpdateTime: globalAuctionState.lastUpdateTime ? globalAuctionState.lastUpdateTime.toISOString() : null,
        timezone: globalAuctionState.timezone,
        intervalMinutes: globalAuctionState.intervalMinutes,
        startingDiscountPercent: globalAuctionState.startingDiscountPercent,
        currentDiscountPercent: globalAuctionState.currentDiscountPercent,
        productsCount: globalAuctionState.products ? globalAuctionState.products.length : 0
      },
      
      // NEW: Database auction record
      databaseRecord: {
        id: auction.id,
        productId: auction.product_id,
        isActive: !!auction.is_active,
        intervalMinutes: auction.interval_minutes,
        reductionPercent: auction.reduction_percent,
        nextUpdate: auction.next_update,
        scheduledStart: auction.scheduled_start,
        timezone: auction.timezone,
        createdAt: auction.created_at,
        originalPrice: auction.original_price,
        currentPrice: auction.current_price
      },
      
      // NEW: Server timing information
      serverInfo: {
        timestamp: currentTime.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        uptime: process.uptime(),
        schedulerStatus: 'active' // Scheduler always runs every minute
      }
    });
  });
});

// Fix logAuctionStatus to show ALL auctions
function logAuctionStatus() {
  console.log('--- Checking auction status ---');
  db.all('SELECT * FROM auctions', (err, rows) => {
    if (err) {
      console.error('Error checking auctions:', err);
    } else {
      console.log(`Found ${rows.length} auctions total`);
      const active = rows.filter(r => r.is_active === 1);
      console.log(`${active.length} are active`);
      
      if (active.length > 0) {
        console.log('Sample of active auctions:');
        // Show just first 5 active auctions as samples
        active.slice(0, 5).forEach(a => {
          console.log(`ID: ${a.id}, Product: ${a.product_id}, Price: ${a.current_price}, Next: ${a.next_update}, Interval: ${a.interval_minutes}min, Reduction: ${a.reduction_percent}%`);
        });
      }
    }
  });
}

// Function to deactivate a specific auction
async function deactivateAuction(auctionId) {
  console.log(`Deactivating auction with ID: ${auctionId}`);
  
  // First get the auction details
  const auction = await new Promise((resolve, reject) => {
    db.get('SELECT * FROM auctions WHERE id = ?', [auctionId], (err, row) => {
      if (err) {
        console.error('Error fetching auction:', err);
        reject(err);
      } else if (!row) {
        reject(new Error(`Auction with ID ${auctionId} not found`));
      } else {
        resolve(row);
      }
    });
  });
  
  // Check if this is the global auction
  if (auction.product_id === 'global') {
    // This is equivalent to stopping all auctions
    console.log('This is the global auction, stopping all auctions');
    globalAuctionState.isRunning = false;
    
    // Deactivate all auctions
    await new Promise((resolve, reject) => {
      db.run('UPDATE auctions SET is_active = 0', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // Reset all product prices
    if (globalAuctionState.products.length > 0) {
      await resetAllProductPrices();
    } else {
      // If we don't have the products in memory, fetch them
      const products = await fetchAllProducts();
      globalAuctionState.products = products;
      await resetAllProductPrices();
    }
    
    // Clear all auction records
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM auctions', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    console.log('All auctions stopped and prices reset');
    globalAuctionState.products = [];
  } else {
    // Individual auction (not used in current implementation, but kept for future use)
    console.log('Deactivating individual auction (not currently used)');
    
    // Mark the auction as inactive
    await new Promise((resolve, reject) => {
      db.run('UPDATE auctions SET is_active = 0 WHERE id = ?', [auctionId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // If there are no more active auctions, reset the global state
    const activeCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM auctions WHERE is_active = 1', (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.count : 0);
      });
    });
    
    if (activeCount === 0) {
      globalAuctionState.isRunning = false;
    }
  }
}

// New endpoint to check scheduled auctions
app.get('/api/scheduled-auctions', (req, res) => {
  console.log('API: Scheduled auctions status check requested');
  
  db.all(
    'SELECT * FROM auctions WHERE scheduled_start IS NOT NULL',
    [],
    (err, rows) => {
      if (err) {
        console.error('API: Error retrieving scheduled auctions:', err);
        return res.status(500).json({
          success: false,
          error: 'Database error',
          message: err.message
        });
      }
      
      // Process rows to make them more readable
      const scheduledAuctions = rows.map(auction => {
        let scheduledStartTime = null;
        let formattedStartTime = null;
        let timeUntilStart = null;
        let timeUntilFormatted = null;
        
        try {
          if (auction.scheduled_start) {
            // Parse the scheduled start time
            scheduledStartTime = new Date(auction.scheduled_start);
            
            // Format in the timezone if specified
            if (auction.timezone) {
              formattedStartTime = moment(scheduledStartTime)
                .tz(auction.timezone)
                .format('YYYY-MM-DD HH:mm:ss');
            } else {
              formattedStartTime = scheduledStartTime.toISOString()
                .replace('T', ' ')
                .split('.')[0];
            }
            
            // Calculate time until start
            const now = new Date();
            timeUntilStart = scheduledStartTime - now;
            
            // Check if the start time is in the past
            if (timeUntilStart <= 0) {
              timeUntilFormatted = 'Started or pending';
            } else {
              // Format the time until start
              const minutes = Math.floor(timeUntilStart / 60000);
              const seconds = Math.floor((timeUntilStart % 60000) / 1000);
              timeUntilFormatted = `${minutes}m ${seconds}s`;
            }
          }
        } catch (error) {
          console.error('API: Error parsing date for auction:', auction.id, error);
        }
        
        return {
          id: auction.id,
          product_id: auction.product_id,
          is_active: auction.is_active === 1,
          interval_minutes: auction.interval_minutes,
          reduction_percent: auction.reduction_percent,
          scheduled_start: scheduledStartTime ? scheduledStartTime.toISOString() : null,
          formatted_start: formattedStartTime,
          timezone: auction.timezone || 'UTC',
          time_until_start: timeUntilStart,
          time_until_formatted: timeUntilFormatted,
          created_at: auction.created_at
        };
      });
      
      // Add global state information
      const globalState = {
        isRunning: globalAuctionState.isRunning,
        scheduledStartTime: globalAuctionState.scheduledStartTime ? 
          globalAuctionState.scheduledStartTime.toISOString() : null,
        currentDiscountPercent: globalAuctionState.currentDiscountPercent,
        lastUpdateTime: globalAuctionState.lastUpdateTime ? 
          globalAuctionState.lastUpdateTime.toISOString() : null,
        intervalMinutes: globalAuctionState.intervalMinutes,
        productCount: globalAuctionState.products.length,
        serverTime: new Date().toISOString()
      };
      
      res.json({
        success: true,
        scheduledAuctions: scheduledAuctions,
        globalState: globalState,
        count: scheduledAuctions.length
      });
    }
  );
});

// Performance monitoring API endpoint
app.get('/api/performance', (req, res) => {
  console.log('Performance metrics API requested');
  
  const metrics = {
    ...performanceMetrics,
    currentTime: new Date().toISOString(),
    optimization: {
      enabled: true,
      improvements: [
        "4x larger batch sizes (20 vs 5 products)",
        "20x larger variant batches (100 vs 5 variants)",
        "50% reduced delays (250ms vs 500ms)",
        "10x parallel processing (10 vs 1 concurrent requests)",
        "Bulk GraphQL mutations",
        "Intelligent fallback mechanisms"
      ],
      expectedSpeedUp: "5-10x faster for large product catalogs"
    }
  };
  
  res.json(metrics);
});

// Add this new diagnostic API endpoint after the other routes
app.get('/api/scheduled-auctions', async (req, res) => {
  try {
    console.log('!!! API: /api/scheduled-auctions requested !!!');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Request from: ${req.headers['user-agent'] || 'Unknown'}`);
    
    // Get scheduled auctions from database
    const scheduledAuctions = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM auctions WHERE scheduled_start IS NOT NULL', (err, rows) => {
        if (err) {
          console.error('Error fetching scheduled auctions:', err);
          reject(err);
        } else {
          console.log(`!!! FOUND ${rows.length} SCHEDULED AUCTIONS IN DATABASE VIA API !!!`);
          
          // Log details of each scheduled auction
          rows.forEach((auction, i) => {
            console.log(`Auction #${i+1}:`);
            console.log(` - ID: ${auction.id}`);
            console.log(` - Product ID: ${auction.product_id}`);
            console.log(` - Scheduled start: ${auction.scheduled_start}`);
            console.log(` - Timezone: ${auction.timezone || 'CET'}`);
            console.log(` - Is active: ${auction.is_active}`);
          });
          
          resolve(rows || []);
        }
      });
    });
    
    // Add info about all auctions for debugging
    const allAuctions = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM auctions', (err, rows) => {
        if (err) {
          console.error('Error fetching all auctions:', err);
          reject(err);
        } else {
          console.log(`Total auctions in database: ${rows.length}`);
          resolve(rows || []);
        }
      });
    });
    
    // Add formatted time for each auction
    const formattedAuctions = scheduledAuctions.map(auction => {
      const scheduledTime = new Date(auction.scheduled_start);
      const timezone = auction.timezone || 'CET';
      const formattedTime = moment(scheduledTime).tz(timezone).format('YYYY-MM-DD HH:mm:ss');
      
      return {
        ...auction,
        formatted_scheduled_start: `${formattedTime} ${timezone}`,
        current_server_time: moment().format('YYYY-MM-DD HH:mm:ss'),
        server_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        time_until_start: scheduledTime > new Date() ? 
          `${Math.floor((scheduledTime - new Date()) / 60000)} minutes` : 'In the past'
      };
    });
    
    // Add global state info
    const diagnosticInfo = {
      scheduledAuctions: formattedAuctions,
      allAuctionsCount: allAuctions.length,
      globalAuctionState: {
        isRunning: globalAuctionState.isRunning,
        scheduledStartTime: globalAuctionState.scheduledStartTime ? 
          globalAuctionState.scheduledStartTime.toISOString() : null,
        timezone: globalAuctionState.timezone,
        intervalMinutes: globalAuctionState.intervalMinutes,
        startingDiscountPercent: globalAuctionState.startingDiscountPercent,
        currentDiscountPercent: globalAuctionState.currentDiscountPercent,
        productCount: globalAuctionState.products ? globalAuctionState.products.length : 0
      },
      serverInfo: {
        currentTime: new Date().toISOString(),
        nodeVersion: process.version,
        platform: process.platform
      }
    };
    
    console.log('!!! API ENDPOINT RETURNED SUCCESSFULLY !!!');
    res.json(diagnosticInfo);
  } catch (error) {
    console.error('Error in scheduled auctions API:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Initialize scheduled auctions on server startup
  initScheduledAuctions().then(() => {
    console.log('Scheduled auction initialization complete.');
    
    // Also log the current auction status
    logAuctionStatus();
  }).catch(err => {
    console.error('Error during scheduled auction initialization:', err);
  });
}); 