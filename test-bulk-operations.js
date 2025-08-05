// Test script to verify the 2025 bulk operations implementation
require('dotenv').config();
const fetch = require('node-fetch');

// Test the actual bulk operations API
async function testBulkOperations() {
  console.log('🧪 Testing 2025 Bulk Operations API...');
  
  // Use Railway environment variables
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const shopUrl = process.env.SHOPIFY_SHOP_URL;
  
  if (!accessToken || !shopUrl) {
    console.error('❌ Missing environment variables:');
    console.error('SHOPIFY_ACCESS_TOKEN:', accessToken ? '✓ Set' : '❌ Missing');
    console.error('SHOPIFY_SHOP_URL:', shopUrl ? '✓ Set' : '❌ Missing');
    return;
  }
  
  console.log('✅ Environment variables found:');
  console.log('🔗 Shop URL:', shopUrl);
  console.log('🔑 Access Token:', accessToken.substring(0, 10) + '...');

  const cleanShopUrl = shopUrl.replace('https://', '').replace('http://', '').trim();
  const url = `https://${cleanShopUrl}/admin/api/2024-04/graphql.json`;
  
  console.log(`🔗 Clean Shop URL: ${cleanShopUrl}`);

  // First, let's get some test variants
  const getVariantsQuery = `
    query {
      products(first: 3) {
        edges {
          node {
            id
            title
            variants(first: 5) {
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

  try {
    console.log('📦 Fetching test products...');
    const getResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ query: getVariantsQuery })
    });

    const getData = await getResponse.json();
    
    if (getData.errors) {
      console.error('❌ GraphQL errors:', getData.errors);
      return;
    }

    if (!getData.data || !getData.data.products.edges.length) {
      console.error('❌ No products found for testing');
      return;
    }

    // Collect test variants
    const testVariants = [];
    for (const productEdge of getData.data.products.edges) {
      const product = productEdge.node;
      console.log(`📦 Product: ${product.title}`);
      
      for (const variantEdge of product.variants.edges) {
        const variant = variantEdge.node;
        const originalPrice = variant.compareAtPrice || variant.price;
        const testPrice = (parseFloat(originalPrice) * 0.95).toFixed(2); // 5% discount
        
        testVariants.push({
          id: variant.id,
          price: testPrice,
          compareAtPrice: originalPrice
        });
        
        console.log(`  🔧 Variant ${variant.id}: ${originalPrice} -> ${testPrice}`);
      }
    }

    console.log(`\n💰 Testing bulk update with ${testVariants.length} variants...`);

    // Test the bulk update mutation
    const bulkUpdateMutation = `
      mutation productVariantsBulkUpdate($productVariants: [ProductVariantInput!]!) {
        productVariantsBulkUpdate(productVariants: $productVariants) {
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
      productVariants: testVariants
    };

    console.log('🚀 Executing bulk update...');
    const startTime = Date.now();

    const bulkResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({
        query: bulkUpdateMutation,
        variables: variables
      })
    });

    const bulkData = await bulkResponse.json();
    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`⏱️  Bulk operation took: ${duration}ms`);

    if (bulkData.errors) {
      console.error('❌ Bulk operation GraphQL errors:', bulkData.errors);
      return;
    }

    if (bulkData.data.productVariantsBulkUpdate.userErrors.length > 0) {
      console.error('❌ Bulk operation user errors:', bulkData.data.productVariantsBulkUpdate.userErrors);
      return;
    }

    const updatedVariants = bulkData.data.productVariantsBulkUpdate.productVariants;
    console.log(`✅ Successfully updated ${updatedVariants.length} variants`);
    console.log(`⚡ Speed: ${Math.round((updatedVariants.length / duration) * 1000)} variants/second`);

    // Now revert the prices back
    console.log('\n🔄 Reverting prices back to original...');
    
    const revertVariants = testVariants.map(variant => ({
      id: variant.id,
      price: variant.compareAtPrice,
      compareAtPrice: variant.compareAtPrice
    }));

    const revertResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({
        query: bulkUpdateMutation,
        variables: { productVariants: revertVariants }
      })
    });

    const revertData = await revertResponse.json();
    
    if (revertData.data.productVariantsBulkUpdate.userErrors.length === 0) {
      console.log('✅ Successfully reverted all prices');
    } else {
      console.error('❌ Failed to revert some prices:', revertData.data.productVariantsBulkUpdate.userErrors);
    }

    console.log('\n🎉 Bulk operations test completed successfully!');
    console.log(`📊 Performance: ${Math.round((testVariants.length / duration) * 1000)} variants/second`);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Test if the API supports the bulk operations
async function testAPISupport() {
  console.log('\n🔍 Testing API support for bulk operations...');
  
  const shopUrl = process.env.SHOPIFY_SHOP_URL.replace('https://', '').replace('http://', '').trim();
  const url = `https://${shopUrl}/admin/api/2024-01/graphql.json`;

  // Test with a simple introspection query
  const introspectionQuery = `
    query {
      __type(name: "Mutation") {
        fields {
          name
          description
        }
      }
    }
  `;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ query: introspectionQuery })
    });

    const data = await response.json();
    
    if (data.errors) {
      console.error('❌ Introspection errors:', data.errors);
      return;
    }

    const mutations = data.data.__type.fields;
    const bulkMutation = mutations.find(field => field.name === 'productVariantsBulkUpdate');
    
    if (bulkMutation) {
      console.log('✅ productVariantsBulkUpdate mutation is available');
      console.log(`📝 Description: ${bulkMutation.description}`);
    } else {
      console.log('❌ productVariantsBulkUpdate mutation is NOT available');
      console.log('📋 Available mutations related to variants:');
      const variantMutations = mutations.filter(field => 
        field.name.toLowerCase().includes('variant')
      );
      variantMutations.forEach(mutation => {
        console.log(`  - ${mutation.name}`);
      });
    }

  } catch (error) {
    console.error('❌ API support test failed:', error.message);
  }
}

// Run all tests
async function runAllTests() {
  console.log('🧪 Starting Bulk Operations Tests');
  console.log('=====================================\n');
  
  await testAPISupport();
  await testBulkOperations();
}

if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = { testBulkOperations, testAPISupport };