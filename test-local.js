// Simple test to verify the auction functionality locally
require('dotenv').config();

// Mock the database and other dependencies for testing
const mockDb = {
  run: (sql, params, callback) => {
    console.log('Mock DB run:', sql);
    if (callback) callback(null);
  },
  all: (sql, callback) => {
    console.log('Mock DB all:', sql);
    if (callback) callback(null, []);
  },
  get: (sql, params, callback) => {
    console.log('Mock DB get:', sql);
    if (callback) callback(null, null);
  }
};

// Mock global state
const globalAuctionState = {
  products: [],
  isRunning: false,
  intervalMinutes: 1,
  startingDiscountPercent: 5,
  currentDiscountPercent: 0,
  lastUpdateTime: null
};

// Test function to validate environment variables
function testEnvironmentSetup() {
  console.log('🧪 Testing Environment Setup...');
  
  const requiredVars = [
    'SHOPIFY_API_KEY',
    'SHOPIFY_API_SECRET', 
    'SHOPIFY_ACCESS_TOKEN',
    'SHOPIFY_SHOP_URL'
  ];
  
  const missing = [];
  requiredVars.forEach(varName => {
    if (!process.env[varName]) {
      missing.push(varName);
    } else {
      console.log(`✅ ${varName} is set`);
    }
  });
  
  if (missing.length > 0) {
    console.error('❌ Missing environment variables:', missing);
    console.log('📝 Please create a .env file with your Shopify credentials');
    return false;
  }
  
  console.log('✅ All environment variables are set');
  return true;
}

// Test GraphQL request function
async function testGraphQLConnection() {
  console.log('\n🧪 Testing GraphQL Connection...');
  
  try {
    const fetch = require('node-fetch');
    const shopUrl = process.env.SHOPIFY_SHOP_URL.replace('https://', '').replace('http://', '').trim();
    const url = `https://${shopUrl}/admin/api/2024-01/graphql.json`;
    
    const testQuery = `
      query {
        shop {
          name
          id
        }
      }
    `;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ query: testQuery })
    });
    
    const data = await response.json();
    
    if (data.errors) {
      console.error('❌ GraphQL errors:', data.errors);
      return false;
    }
    
    if (data.data && data.data.shop) {
      console.log('✅ GraphQL connection successful');
      console.log(`📊 Shop: ${data.data.shop.name}`);
      return true;
    }
    
    console.error('❌ Unexpected GraphQL response:', data);
    return false;
    
  } catch (error) {
    console.error('❌ GraphQL connection failed:', error.message);
    return false;
  }
}

// Test fetching a small number of products
async function testProductFetch() {
  console.log('\n🧪 Testing Product Fetch...');
  
  try {
    const fetch = require('node-fetch');
    const shopUrl = process.env.SHOPIFY_SHOP_URL.replace('https://', '').replace('http://', '').trim();
    const url = `https://${shopUrl}/admin/api/2024-01/graphql.json`;
    
    const query = `
      query {
        products(first: 3) {
          edges {
            node {
              id
              title
              variants(first: 2) {
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
    `;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ query })
    });
    
    const data = await response.json();
    
    if (data.errors) {
      console.error('❌ Product fetch errors:', data.errors);
      return false;
    }
    
    if (data.data && data.data.products) {
      const products = data.data.products.edges;
      console.log(`✅ Fetched ${products.length} products`);
      
      products.forEach((productEdge, i) => {
        const product = productEdge.node;
        console.log(`📦 Product ${i + 1}: ${product.title}`);
        console.log(`   Variants: ${product.variants.edges.length}`);
        
        product.variants.edges.forEach((variantEdge, j) => {
          const variant = variantEdge.node;
          console.log(`   🔧 Variant ${j + 1}: ID=${variant.id} Price=${variant.price} CompareAt=${variant.compareAtPrice}`);
        });
      });
      
      return true;
    }
    
    console.error('❌ No products in response');
    return false;
    
  } catch (error) {
    console.error('❌ Product fetch failed:', error.message);
    return false;
  }
}

// Test variant price update
async function testVariantUpdate() {
  console.log('\n🧪 Testing Variant Price Update...');
  
  try {
    const fetch = require('node-fetch');
    const shopUrl = process.env.SHOPIFY_SHOP_URL.replace('https://', '').replace('http://', '').trim();
    const url = `https://${shopUrl}/admin/api/2024-01/graphql.json`;
    
    // First get a variant to test with
    const getQuery = `
      query {
        products(first: 1) {
          edges {
            node {
              variants(first: 1) {
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
    `;
    
    const getResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ query: getQuery })
    });
    
    const getData = await getResponse.json();
    
    if (!getData.data || !getData.data.products.edges[0]) {
      console.error('❌ No products found for testing');
      return false;
    }
    
    const testVariant = getData.data.products.edges[0].node.variants.edges[0].node;
    console.log(`🎯 Testing with variant: ${testVariant.id}`);
    console.log(`   Current price: ${testVariant.price}`);
    console.log(`   Compare at: ${testVariant.compareAtPrice}`);
    
    // Calculate a small test discount (1% off)
    const originalPrice = parseFloat(testVariant.price);
    const discountedPrice = (originalPrice * 0.99).toFixed(2);
    
    console.log(`📉 Testing 1% discount: ${originalPrice} -> ${discountedPrice}`);
    
    // Test the update mutation
    const updateMutation = `
      mutation {
        productVariantUpdate(input: {
          id: "${testVariant.id}"
          price: "${discountedPrice}"
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
      }
    `;
    
    const updateResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ query: updateMutation })
    });
    
    const updateData = await updateResponse.json();
    
    if (updateData.errors) {
      console.error('❌ Mutation errors:', updateData.errors);
      return false;
    }
    
    if (updateData.data.productVariantUpdate.userErrors.length > 0) {
      console.error('❌ User errors:', updateData.data.productVariantUpdate.userErrors);
      return false;
    }
    
    const updatedVariant = updateData.data.productVariantUpdate.productVariant;
    console.log(`✅ Successfully updated variant price to: ${updatedVariant.price}`);
    
    // Revert the price back
    const revertMutation = `
      mutation {
        productVariantUpdate(input: {
          id: "${testVariant.id}"
          price: "${originalPrice.toFixed(2)}"
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
      }
    `;
    
    const revertResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ query: revertMutation })
    });
    
    const revertData = await revertResponse.json();
    
    if (revertData.data.productVariantUpdate.userErrors.length === 0) {
      console.log(`✅ Successfully reverted price back to: ${originalPrice.toFixed(2)}`);
      return true;
    } else {
      console.error('❌ Failed to revert price:', revertData.data.productVariantUpdate.userErrors);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Variant update test failed:', error.message);
    return false;
  }
}

// Run all tests
async function runAllTests() {
  console.log('🚀 Starting Local Auction System Tests');
  console.log('=====================================\n');
  
  const envTest = testEnvironmentSetup();
  if (!envTest) return;
  
  const graphqlTest = await testGraphQLConnection();
  if (!graphqlTest) return;
  
  const productTest = await testProductFetch();
  if (!productTest) return;
  
  const updateTest = await testVariantUpdate();
  if (!updateTest) return;
  
  console.log('\n🎉 ALL TESTS PASSED!');
  console.log('✅ Your Shopify connection is working correctly');
  console.log('✅ GraphQL queries are working');
  console.log('✅ Product fetching is working');
  console.log('✅ Price updates are working');
  console.log('\n📋 Your auction system should work properly when deployed!');
}

// Run the tests if this file is executed directly
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = {
  testEnvironmentSetup,
  testGraphQLConnection,
  testProductFetch,
  testVariantUpdate,
  runAllTests
};