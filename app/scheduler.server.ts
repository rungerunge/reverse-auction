import cron from "node-cron";
import prisma from "./db.server";
import { shopify } from "./shopify.server";

// Run every minute to check for auction updates
cron.schedule("* * * * *", async () => {
  console.log("Running auction scheduler...");

  const configs = await prisma.auctionConfig.findMany({
    where: { isActive: true },
  });

  for (const config of configs) {
    const now = new Date();
    const startTime = new Date(config.startTime);
    
    // Calculate time difference in minutes
    const diffMs = now.getTime() - startTime.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);

    // Check if we are 1.5 minutes before a drop interval
    // We check if (diffMinutes + 1.5) % dropIntervalMinutes is close to 0
    // Or simpler: check if we are within the 2-minute window of a scheduled drop
    // Let's just run exactly when needed. 
    // The requirement: "starts the job 1.5 minutes before the job"
    
    // Calculate the next drop time
    const intervalsPassed = Math.floor(diffMinutes / config.dropIntervalMinutes);
    const nextDropTime = new Date(startTime.getTime() + (intervalsPassed + 1) * config.dropIntervalMinutes * 60000);
    
    // Check if we are roughly 1.5 minutes before the next drop
    const timeUntilNextDrop = nextDropTime.getTime() - now.getTime();
    const minutesUntilNextDrop = timeUntilNextDrop / 60000;

    if (minutesUntilNextDrop > 1.4 && minutesUntilNextDrop < 1.6) {
       console.log(`Triggering price drop for ${config.shop}`);
       await performPriceDrop(config);
    }
  }
});

async function performPriceDrop(config: any) {
  const { shop, startTime, dropIntervalMinutes, dropPercentage, maxDiscount, startDiscount } = config;
  
  // Calculate current discount level
  const now = new Date();
  // Add 2 minutes to account for the "1.5 min before" start time so we calculate the *target* discount
  const effectiveTime = new Date(now.getTime() + 2 * 60000);
  const diffMs = effectiveTime.getTime() - new Date(startTime).getTime();
  const intervalsPassed = Math.floor(diffMs / (dropIntervalMinutes * 60000));
  
  let currentDiscount = startDiscount + (intervalsPassed * dropPercentage);
  
  if (currentDiscount > maxDiscount) {
    currentDiscount = maxDiscount;
  }

  console.log(`Applying ${currentDiscount}% discount for ${shop}`);

  // Fetch all products and update prices
  // This needs to be done via GraphQL Bulk Operation for scalability
  // For simplicity in this MVP, we'll use a regular query/mutation loop but strictly warn about limits
  
  // In a real production app with thousands of products, use bulkOperationRunQuery and bulkOperationRunMutation
  
  try {
    const session = await prisma.session.findFirst({ where: { shop } });
    if (!session) return;

    const client = new shopify.api.clients.Graphql({ session });

    // 1. Fetch all product variants
    // Note: Pagination needed for > 250 items
    const productsResponse = await client.request(`
      query {
        products(first: 50) {
          edges {
            node {
              id
              variants(first: 50) {
                edges {
                  node {
                    id
                    price
                    compareAtPrice
                  }
                }
              }
            }
          }
        }
      }
    `);

    const products = productsResponse.data.products.edges;

    const variantsToUpdate = [];

    for (const productEdge of products) {
      const product = productEdge.node;
      for (const variantEdge of product.node.variants.edges) {
        const variant = variantEdge.node;
        
        // Original price logic:
        // We assume 'compareAtPrice' is the ORIGINAL price. 
        // If compareAtPrice is null, set it to current price before discounting.
        
        let originalPrice = parseFloat(variant.compareAtPrice);
        if (!originalPrice) {
            originalPrice = parseFloat(variant.price);
            // If we are starting the auction, we need to set compareAtPrice
        }

        const newPrice = (originalPrice * (1 - currentDiscount / 100)).toFixed(2);

        variantsToUpdate.push({
          id: variant.id,
          price: newPrice,
          // Ensure compareAtPrice is set so we track the base
          compareAtPrice: originalPrice.toFixed(2) 
        });
      }
    }

    // 2. Bulk Update (using mutation loop for now, but should be bulk mutation)
    if (variantsToUpdate.length > 0) {
       // Use productVariantsBulkUpdate
       // We need to group by product, but the mutation takes a list of variants regardless of product? 
       // No, productVariantsBulkUpdate takes a productId. So we need to group by product.
       
       // Re-organize by product
       const updatesByProduct: any = {};
       
       for (const productEdge of products) {
         const productId = productEdge.node.id;
         updatesByProduct[productId] = [];
         
         for (const variantEdge of productEdge.node.variants.edges) {
             const variant = variantEdge.node;
             const update = variantsToUpdate.find(v => v.id === variant.id);
             if (update) {
                 updatesByProduct[productId].push({
                     id: update.id,
                     price: update.price,
                     compareAtPrice: update.compareAtPrice
                 });
             }
         }
       }

       for (const productId of Object.keys(updatesByProduct)) {
           const variants = updatesByProduct[productId];
           
           await client.request(`
             mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
               productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                 userErrors {
                   field
                   message
                 }
               }
             }
           `, {
             variables: {
               productId,
               variants
             }
           });
       }
    }
    
    await prisma.auctionLog.create({
        data: {
            shop,
            action: "PRICE_DROP",
            details: `Applied ${currentDiscount}% discount`
        }
    });

  } catch (error) {
    console.error("Error updating prices:", error);
  }
}

