var express = require('express');
var router = express.Router();
const axios = require('axios');
const logger = require('../utils/logger');
const { getProductInfo, getProductByID } = require("../public/javascripts/psn-handler");

// Regional endpoint configuration
const REGIONAL_ENDPOINTS = {
  US: 'https://store.playstation.com/en-us/api',
  EU: 'https://store.playstation.com/en-gb/api',
  JP: 'https://store.playstation.com/ja-jp/api',
  AU: 'https://store.playstation.com/en-au/api'
};

// Timeout configuration for API calls
const data = await getProductInfo(query, regionCode);

/**
 * Search for PlayStation games across regional stores
 * GET /search?query=<search_term>&region=<region>&limit=<limit>
 */
router.get('/search', async (req, res) => {
  try {
    const data = await getProductInfo(query, regionCode);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
    // Validate input
    if (!query) {
      logger.warn('Search request without query parameter', { ip: req.ip });
      return res.status(400).json({
        error: 'Missing required parameter: query',
        success: false
      });
    }

    if (!Object.keys(REGIONAL_ENDPOINTS).includes(region.toUpperCase())) {
      logger.warn('Invalid region requested', { region, ip: req.ip });
      return res.status(400).json({
        error: `Invalid region. Supported regions: ${Object.keys(REGIONAL_ENDPOINTS).join(', ')}`,
        success: false
      });
    }

    logger.info('Starting search request', { 
      query, 
      region: region.toUpperCase(), 
      limit,
      ip: req.ip 
    });

    const endpoint = REGIONAL_ENDPOINTS[region.toUpperCase()];
    
    // Fetch search results with timeout and error handling
    const response = await fetchSearchResults(query, endpoint, limit);

    logger.info('Search completed successfully', {
      query,
      region: region.toUpperCase(),
      resultsCount: response.products.length,
      ip: req.ip
    });

    res.json({
      success: true,
      query,
      region: region.toUpperCase(),
      totalResults: response.products.length,
      products: response.products
    });

  } catch (error) {
    handleSearchError(error, res, req);
  }
});

/**
 * Fetch search results from regional endpoint with graceful degradation
 */
async function fetchSearchResults(query, endpoint, limit) {
  try {
    logger.debug('Fetching from endpoint', { endpoint, query });

    const response = await axios.get(`${endpoint}/v2/graphql`, {
      timeout: REQUEST_TIMEOUT,
      params: {
        operationName: 'SearchStoreQuery',
        variables: JSON.stringify({
          query,
          first: limit,
          filter: { isPublished: true }
        })
      },
      headers: {
        'User-Agent': 'PSN-API-Client/1.0',
        'Accept': 'application/json'
      }
    });

    if (!response.data || !response.data.data) {
      throw new Error('Invalid API response structure');
    }

    // Process and sanitize products with graceful degradation
    const products = (response.data.data.products || []).map(product => 
      sanitizeProduct(product)
    );

    logger.debug('Successfully processed products', { count: products.length });

    return { products };

  } catch (error) {
    if (error.response?.status === 404) {
      logger.warn('Regional endpoint not available', { endpoint });
      throw new Error(`Regional store (${endpoint}) is currently unavailable`);
    } else if (error.code === 'ECONNABORTED') {
      logger.warn('Request timeout for endpoint', { endpoint, timeout: REQUEST_TIMEOUT });
      throw new Error('Request timeout - regional store is responding slowly');
    } else if (error.code === 'ENOTFOUND') {
      logger.error('DNS resolution failed', { endpoint });
      throw new Error('Cannot reach regional store - network error');
    }
    throw error;
  }
}

/**
 * Sanitize and normalize product data with graceful degradation
 */
function sanitizeProduct(product) {
  try {
    // Gracefully handle missing or incomplete product data
    const sanitized = {
      id: product.id || 'unknown-id',
      name: product.name || 'Unknown Product',
      description: product.description || 'No description available',
      releaseDate: product.releaseDate || null,
      contentRating: product.contentRating || 'Not rated',
      genre: product.genre || [],
      
      // Graceful degradation for price data
      price: sanitizePrice(product.price),
      discountPrice: sanitizePrice(product.discountPrice),
      discountPercentage: sanitizeDiscount(product.discountPercentage),
      
      // Image handling
      image: sanitizeImage(product.image),
      
      // Store specific data
      storeUrl: product.storeUrl || null,
      platform: product.platform || 'PS4/PS5'
    };

    return sanitized;

  } catch (err) {
    logger.error('Error sanitizing product', { 
      productId: product?.id, 
      error: err.message 
    });
    
    // Return minimal safe product object on error
    return {
      id: product?.id || 'unknown-id',
      name: product?.name || 'Unknown Product',
      error: 'Incomplete product data',
      price: { amount: null, currency: 'Unknown' },
      image: null
    };
  }
}

/**
 * Sanitize price data with graceful degradation for missing values
 */
function sanitizePrice(price) {
  try {
    if (!price) {
      logger.debug('Missing price data for product');
      return {
        amount: null,
        currency: 'Unknown',
        formatted: 'Price not available',
        available: false
      };
    }

    return {
      amount: typeof price.amount === 'number' ? price.amount : null,
      currency: price.currency || 'Unknown',
      formatted: price.formatted || formatPrice(price.amount, price.currency),
      available: price.amount !== null && price.amount !== undefined
    };

  } catch (err) {
    logger.warn('Error processing price data', { error: err.message });
    return {
      amount: null,
      currency: 'Unknown',
      formatted: 'Price unavailable',
      available: false
    };
  }
}

/**
 * Sanitize discount information
 */
function sanitizeDiscount(discount) {
  try {
    if (!discount || typeof discount !== 'number') {
      return 0;
    }
    
    const normalized = Math.min(Math.max(discount, 0), 100);
    return Math.round(normalized);

  } catch (err) {
    logger.warn('Error processing discount', { error: err.message });
    return 0;
  }
}

/**
 * Sanitize image URL
 */
function sanitizeImage(image) {
  try {
    if (!image) {
      logger.debug('Missing image data');
      return null;
    }

    if (typeof image === 'string') {
      return image.startsWith('http') ? image : null;
    }

    if (typeof image === 'object' && image.url) {
      return image.url.startsWith('http') ? image.url : null;
    }

    return null;

  } catch (err) {
    logger.warn('Error processing image data', { error: err.message });
    return null;
  }
}

/**
 * Format price value with currency
 */
function formatPrice(amount, currency) {
  try {
    if (amount === null || amount === undefined) {
      return 'Price not available';
    }

    const currencySymbols = {
      'USD': '$',
      'EUR': '€',
      'GBP': '£',
      'JPY': '¥',
      'AUD': '$'
    };

    const symbol = currencySymbols[currency] || currency;
    return `${symbol}${amount.toFixed(2)}`;

  } catch (err) {
    logger.warn('Error formatting price', { amount, currency, error: err.message });
    return 'Price unavailable';
  }
}

/**
 * Handle search errors with appropriate logging and responses
 */
function handleSearchError(error, res, req) {
  const errorContext = {
    ip: req.ip,
    query: req.query.query,
    region: req.query.region || 'US',
    timestamp: new Date().toISOString()
  };

  // Regional/Store specific errors
  if (error.message.includes('regional store')) {
    logger.error('Regional store error', { 
      ...errorContext,
      error: error.message 
    });
    
    return res.status(503).json({
      success: false,
      error: error.message,
      suggestion: 'Try a different region or try again later',
      availableRegions: Object.keys(REGIONAL_ENDPOINTS)
    });
  }

  // Timeout errors
  if (error.message.includes('timeout')) {
    logger.warn('Search request timeout', { 
      ...errorContext,
      error: error.message 
    });
    
    return res.status(504).json({
      success: false,
      error: 'Request timeout',
      suggestion: 'The regional store is responding slowly. Please try again.',
      retryable: true
    });
  }

  // Network errors
  if (error.message.includes('network error') || error.message.includes('DNS')) {
    logger.error('Network error during search', { 
      ...errorContext,
      error: error.message 
    });
    
    return res.status(503).json({
      success: false,
      error: 'Network connectivity issue',
      suggestion: 'Unable to reach the regional store. Please try again later.',
      retryable: true
    });
  }

  // Generic API errors
  if (error.response?.status) {
    const status = error.response.status;
    const statusMessage = `HTTP ${status}`;
    
    logger.error('API error during search', { 
      ...errorContext,
      status,
      error: error.message 
    });

    if (status === 429) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        suggestion: 'Too many requests. Please wait and try again.',
        retryable: true
      });
    }

    if (status >= 500) {
      return res.status(status).json({
        success: false,
        error: 'Regional store server error',
        suggestion: 'The regional store is experiencing issues. Try again later.',
        retryable: true
      });
    }

    return res.status(status).json({
      success: false,
      error: statusMessage,
      retryable: false
    });
  }

  // Unknown errors
  logger.error('Unexpected error during search', { 
    ...errorContext,
    error: error.message,
    stack: error.stack 
  });

  res.status(500).json({
    success: false,
    error: 'An unexpected error occurred',
    suggestion: 'Please try again later or contact support.',
    retryable: false
  });
}

const getProductById = async (req, res) => {
  try {
    const { productId, region } = req.query;
    
    if (!productId) {
      return res.status(400).json({ error: "productId parameter is required" });
    }

    const regionCode = region || 'BE'; // Default to Belgium
    const data = await getProductByID(productId, regionCode);
    res.status(200).json(data);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// Register the new route
router.get('/by-id', getProductById);
module.exports = router;
