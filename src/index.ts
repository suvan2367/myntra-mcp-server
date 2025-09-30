#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Redis from 'redis';
import axios from 'axios';
import 'isomorphic-fetch';

interface SellerTokens {
    accessToken?: string;
    refreshToken?: string;
    expiresOn?: number;
    sellerId?: string;
}



class MyntraSellerMCPServer {
    private server!: Server;
    private app: express.Application;
    private redis: any;
    private sellerTokens: Map<string, SellerTokens> = new Map();
    private myntraApiBase: string;

    constructor() {
        this.app = express();
        this.myntraApiBase = process.env.MYNTRA_API_BASE || 'https://api.myntra.com/seller';
        this.setupRedis();
        this.setupExpress();
        this.setupMCPServer();
        this.setupToolHandlers();
    }

    private async setupRedis() {
        if (process.env.REDIS_URL) {
            this.redis = Redis.createClient({
                url: process.env.REDIS_URL,
                socket: {
                    reconnectStrategy: (retries) => Math.min(retries * 50, 500)
                }
            });

            this.redis.on('error', (err: any) => {
                console.error('Redis Client Error', err);
            });

            await this.redis.connect();
            console.log('Connected to Redis for token storage');
        } else {
            console.log('No Redis URL provided, using in-memory token storage');
        }
    }

    private setupExpress() {
        this.app.set('trust proxy', 1);

        this.app.use(helmet({
            crossOriginEmbedderPolicy: false,
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    connectSrc: ["'self'", "https://api.myntra.com"],
                },
            },
        }));

        this.app.use(cors({
            origin: (origin, callback) => {
                const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
                    'https://claude.ai',
                    'https://chatgpt.com',
                    'http://localhost:3000'
                ];
                if (!origin || allowedOrigins.includes(origin)) {
                    callback(null, true);
                } else {
                    callback(new Error('Not allowed by CORS'));
                }
            },
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
        }));

        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 1000,
            message: {
                error: 'Too many requests from this IP',
                retryAfter: 15 * 60
            },
            standardHeaders: true,
            legacyHeaders: false,
        });
        this.app.use(limiter);

        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.status(200).json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                version: process.env.npm_package_version || '1.0.0',
                environment: process.env.NODE_ENV || 'development',
                uptime: process.uptime(),
                memory: process.memoryUsage(),
            });
        });

        // Readiness check
        this.app.get('/ready', async (req, res) => {
            try {
                if (this.redis) {
                    await this.redis.ping();
                }
                res.status(200).json({ status: 'ready' });
            } catch (error) {
                res.status(503).json({ status: 'not ready', error: (error as Error).message });
            }
        });

        // Metrics endpoint
        this.app.get('/metrics', (req, res) => {
            const metrics = {
                nodejs_memory_usage_bytes: process.memoryUsage(),
                nodejs_uptime_seconds: process.uptime(),
                http_requests_total: res.get('X-Request-Count') || 0,
                active_connections: this.sellerTokens.size,
            };
            res.set('Content-Type', 'text/plain');
            res.send(Object.entries(metrics).map(([key, value]) =>
                typeof value === 'object'
                    ? Object.entries(value).map(([k, v]) => `${key}_{${k}} ${v}`).join('\n')
                    : `${key} ${value}`
            ).join('\n'));
        });

        // Authentication endpoints
        this.app.post('/auth/login', async (req, res) => {
            const { sellerId, apiKey, apiSecret } = req.body;

            if (!sellerId || !apiKey || !apiSecret) {
                res.status(400).json({
                    error: 'Missing required fields',
                    required: ['sellerId', 'apiKey', 'apiSecret'],
                    timestamp: new Date().toISOString()
                });
                return;
            }

            try {
                // Authenticate with Myntra API
                const response = await axios.post(`${this.myntraApiBase}/auth/token`, {
                    seller_id: sellerId,
                    api_key: apiKey,
                    api_secret: apiSecret,
                });

                const tokens: SellerTokens = {
                    accessToken: response.data.access_token,
                    refreshToken: response.data.refresh_token,
                    expiresOn: Date.now() + (response.data.expires_in * 1000),
                    sellerId: sellerId,
                };

                await this.storeTokens(sellerId, tokens);

                res.status(200).json({
                    success: true,
                    message: 'Authentication successful',
                    sellerId: sellerId,
                    expiresIn: response.data.expires_in,
                    timestamp: new Date().toISOString()
                });
            } catch (error: any) {
                console.error('Authentication error:', error);
                res.status(401).json({
                    error: 'Authentication failed',
                    details: error.response?.data?.message || error.message,
                    timestamp: new Date().toISOString()
                });
            }
        });

        // Get authentication status
        this.app.get('/auth/status/:sellerId', async (req, res) => {
            try {
                const { sellerId } = req.params;
                const isAuthenticated = await this.checkAuthentication(sellerId);

                if (isAuthenticated) {
                    const tokens = await this.getTokens(sellerId);
                    res.json({
                        authenticated: true,
                        sellerId: tokens?.sellerId,
                        expiresIn: tokens?.expiresOn ? Math.floor((tokens.expiresOn - Date.now()) / 1000) : 0,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    res.json({
                        authenticated: false,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (error) {
                res.status(500).json({
                    error: 'Failed to check authentication status',
                    details: (error as Error).message,
                    timestamp: new Date().toISOString()
                });
            }
        });

        // Revoke authentication
        this.app.post('/auth/logout/:sellerId', async (req, res) => {
            try {
                const { sellerId } = req.params;
                await this.revokeTokens(sellerId);
                res.json({
                    success: true,
                    message: 'Logged out successfully',
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                res.status(500).json({
                    error: 'Failed to logout',
                    details: (error as Error).message,
                    timestamp: new Date().toISOString()
                });
            }
        });
    }

    private setupMCPServer() {
        this.server = new Server(
            {
                name: 'myntra-seller-mcp-server',
                version: process.env.npm_package_version || '1.0.0',
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );
    }

    private async storeTokens(sellerId: string, tokens: SellerTokens): Promise<void> {
        if (this.redis) {
            try {
                await this.redis.setEx(
                    `myntra_tokens:${sellerId}`,
                    3600 * 24 * 7,
                    JSON.stringify(tokens)
                );
            } catch (error) {
                console.error('Failed to store tokens in Redis:', error);
                this.sellerTokens.set(sellerId, tokens);
            }
        } else {
            this.sellerTokens.set(sellerId, tokens);
        }
    }

    private async getTokens(sellerId: string): Promise<SellerTokens | null> {
        if (this.redis) {
            try {
                const tokensData = await this.redis.get(`myntra_tokens:${sellerId}`);
                return tokensData ? JSON.parse(tokensData) : null;
            } catch (error) {
                console.error('Failed to get tokens from Redis:', error);
                return this.sellerTokens.get(sellerId) || null;
            }
        } else {
            return this.sellerTokens.get(sellerId) || null;
        }
    }

    private async revokeTokens(sellerId: string): Promise<void> {
        if (this.redis) {
            try {
                await this.redis.del(`myntra_tokens:${sellerId}`);
            } catch (error) {
                console.error('Failed to delete tokens from Redis:', error);
            }
        }
        this.sellerTokens.delete(sellerId);
    }

    private async checkAuthentication(sellerId: string): Promise<boolean> {
        const tokens = await this.getTokens(sellerId);
        if (!tokens?.accessToken) {
            return false;
        }

        if (tokens.expiresOn && Date.now() < tokens.expiresOn) {
            return true;
        }

        // Try to refresh token
        if (tokens.refreshToken) {
            try {
                const response = await axios.post(`${this.myntraApiBase}/auth/refresh`, {
                    refresh_token: tokens.refreshToken,
                });

                const updatedTokens: SellerTokens = {
                    accessToken: response.data.access_token,
                    refreshToken: response.data.refresh_token || tokens.refreshToken,
                    expiresOn: Date.now() + (response.data.expires_in * 1000),
                    sellerId: sellerId,
                };

                await this.storeTokens(sellerId, updatedTokens);
                return true;
            } catch (error) {
                console.error('Token refresh failed:', error);
                await this.revokeTokens(sellerId);
            }
        }

        return false;
    }

    private async makeApiRequest(sellerId: string, method: string, endpoint: string, data?: any) {
        const tokens = await this.getTokens(sellerId);
        if (!tokens?.accessToken) {
            throw new Error('Not authenticated');
        }

        try {
            const response = await axios({
                method,
                url: `${this.myntraApiBase}${endpoint}`,
                headers: {
                    'Authorization': `Bearer ${tokens.accessToken}`,
                    'Content-Type': 'application/json',
                },
                data,
            });

            return response.data;
        } catch (error: any) {
            throw new Error(error.response?.data?.message || error.message);
        }
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'myntra_authenticate',
                        description: 'Authenticate with Myntra Seller API',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Myntra Seller ID'
                                },
                                api_key: {
                                    type: 'string',
                                    description: 'API Key from Myntra Seller Dashboard'
                                },
                                api_secret: {
                                    type: 'string',
                                    description: 'API Secret from Myntra Seller Dashboard'
                                },
                            },
                            required: ['seller_id', 'api_key', 'api_secret']
                        }
                    },
                    {
                        name: 'myntra_status',
                        description: 'Check Myntra seller account status',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                }
                            },
                            required: ['seller_id']
                        }
                    },
                    {
                        name: 'myntra_list_products',
                        description: 'List all products in your catalog',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                status: {
                                    type: 'string',
                                    enum: ['active', 'inactive', 'pending', 'rejected', 'all'],
                                    description: 'Filter by product status',
                                    default: 'all'
                                },
                                category: {
                                    type: 'string',
                                    description: 'Filter by category'
                                },
                                limit: {
                                    type: 'number',
                                    description: 'Maximum products to return',
                                    default: 50
                                },
                                offset: {
                                    type: 'number',
                                    description: 'Offset for pagination',
                                    default: 0
                                },
                            },
                            required: ['seller_id']
                        }
                    },
                    {
                        name: 'myntra_get_product',
                        description: 'Get detailed information about a specific product',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                product_id: {
                                    type: 'string',
                                    description: 'Product SKU or ID'
                                },
                            },
                            required: ['seller_id', 'product_id']
                        }
                    },
                    {
                        name: 'myntra_create_product',
                        description: 'Create a new product listing',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                sku: {
                                    type: 'string',
                                    description: 'Product SKU'
                                },
                                name: {
                                    type: 'string',
                                    description: 'Product name'
                                },
                                brand: {
                                    type: 'string',
                                    description: 'Brand name'
                                },
                                category: {
                                    type: 'string',
                                    description: 'Product category'
                                },
                                description: {
                                    type: 'string',
                                    description: 'Product description'
                                },
                                mrp: {
                                    type: 'number',
                                    description: 'Maximum Retail Price'
                                },
                                selling_price: {
                                    type: 'number',
                                    description: 'Selling price'
                                },
                                inventory: {
                                    type: 'number',
                                    description: 'Available inventory'
                                },
                                images: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Product image URLs'
                                },
                            },
                            required: ['seller_id', 'sku', 'name', 'brand', 'category', 'mrp', 'selling_price', 'inventory']
                        }
                    },
                    {
                        name: 'myntra_update_product',
                        description: 'Update an existing product',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                product_id: {
                                    type: 'string',
                                    description: 'Product SKU or ID'
                                },
                                updates: {
                                    type: 'object',
                                    description: 'Fields to update (e.g., {selling_price: 999, inventory: 50})'
                                },
                            },
                            required: ['seller_id', 'product_id', 'updates']
                        }
                    },
                    {
                        name: 'myntra_update_inventory',
                        description: 'Update product inventory',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                product_id: {
                                    type: 'string',
                                    description: 'Product SKU or ID'
                                },
                                quantity: {
                                    type: 'number',
                                    description: 'New inventory quantity'
                                },
                            },
                            required: ['seller_id', 'product_id', 'quantity']
                        }
                    },
                    {
                        name: 'myntra_list_orders',
                        description: 'List orders with optional filtering',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                status: {
                                    type: 'string',
                                    enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned', 'all'],
                                    description: 'Filter by order status',
                                    default: 'all'
                                },
                                from_date: {
                                    type: 'string',
                                    description: 'Start date (YYYY-MM-DD)'
                                },
                                to_date: {
                                    type: 'string',
                                    description: 'End date (YYYY-MM-DD)'
                                },
                                limit: {
                                    type: 'number',
                                    description: 'Maximum orders to return',
                                    default: 50
                                },
                            },
                            required: ['seller_id']
                        }
                    },
                    {
                        name: 'myntra_get_order',
                        description: 'Get detailed information about a specific order',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                order_id: {
                                    type: 'string',
                                    description: 'Order ID'
                                },
                            },
                            required: ['seller_id', 'order_id']
                        }
                    },
                    {
                        name: 'myntra_update_order_status',
                        description: 'Update order status (ready to ship, shipped, etc.)',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                order_id: {
                                    type: 'string',
                                    description: 'Order ID'
                                },
                                status: {
                                    type: 'string',
                                    enum: ['ready_to_ship', 'shipped', 'cancelled'],
                                    description: 'New order status'
                                },
                                tracking_id: {
                                    type: 'string',
                                    description: 'Tracking ID (required for shipped status)'
                                },
                                courier_partner: {
                                    type: 'string',
                                    description: 'Courier partner name'
                                },
                            },
                            required: ['seller_id', 'order_id', 'status']
                        }
                    },
                    {
                        name: 'myntra_get_returns',
                        description: 'List return requests',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                status: {
                                    type: 'string',
                                    enum: ['pending', 'approved', 'rejected', 'completed', 'all'],
                                    description: 'Filter by return status',
                                    default: 'pending'
                                },
                                limit: {
                                    type: 'number',
                                    description: 'Maximum returns to return',
                                    default: 25
                                },
                            },
                            required: ['seller_id']
                        }
                    },
                    {
                        name: 'myntra_process_return',
                        description: 'Approve or reject a return request',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                return_id: {
                                    type: 'string',
                                    description: 'Return request ID'
                                },
                                action: {
                                    type: 'string',
                                    enum: ['approve', 'reject'],
                                    description: 'Action to take'
                                },
                                reason: {
                                    type: 'string',
                                    description: 'Reason for rejection (if applicable)'
                                },
                            },
                            required: ['seller_id', 'return_id', 'action']
                        }
                    },
                    {
                        name: 'myntra_get_analytics',
                        description: 'Get sales and performance analytics',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                seller_id: {
                                    type: 'string',
                                    description: 'Seller ID'
                                },
                                metric: {
                                    type: 'string',
                                    enum: ['sales', 'orders', 'revenue', 'top_products', 'inventory_health'],
                                    description: 'Metric to retrieve',
                                    default: 'sales'
                                },
                                from_date: {
                                    type: 'string',
                                    description: 'Start date (YYYY-MM-DD)'
                                },
                                to_date: {
                                    type: 'string',
                                    description: 'End date (YYYY-MM-DD)'
                                },
                            },
                            required: ['seller_id', 'metric']
                        }
                    },
                ]
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const sellerId = args?.seller_id as string;

            try {
                switch (name) {
                    case 'myntra_authenticate':
                        return await this.handleAuthenticate(args || {});
                    case 'myntra_status':
                        return await this.handleStatus(sellerId);
                    default:
                        if (!sellerId) {
                            return {
                                content: [{
                                    type: 'text',
                                    text: 'Error: seller_id is required for all Myntra operations.'
                                }],
                                isError: true
                            };
                        }

                        if (!(await this.checkAuthentication(sellerId))) {
                            return {
                                content: [{
                                    type: 'text',
                                    text: 'Not authenticated with Myntra. Please authenticate first using myntra_authenticate.'
                                }],
                                isError: true
                            };
                        }

                        return await this.handleMyntraOperation(name, args || {});
                }
            } catch (error) {
                console.error(`Error in ${name}:`, error);
                throw new McpError(
                    ErrorCode.InternalError,
                    `Error executing ${name}: ${(error as Error).message}`
                );
            }
        });
    }

    private async handleAuthenticate(args: any) {
        try {
            const { seller_id, api_key, api_secret } = args;

            if (!seller_id || !api_key || !api_secret) {
                return {
                    content: [{
                        type: 'text',
                        text: 'Error: seller_id, api_key, and api_secret are required for authentication.'
                    }],
                    isError: true
                };
            }

            // Check if already authenticated
            if (await this.checkAuthentication(seller_id)) {
                return {
                    content: [{
                        type: 'text',
                        text: `Already authenticated with Myntra!\n\nSeller ID: ${seller_id}`
                    }]
                };
            }

            // Authenticate with Myntra API
            const response = await axios.post(`${this.myntraApiBase}/auth/token`, {
                seller_id,
                api_key,
                api_secret,
            });

            const tokens: SellerTokens = {
                accessToken: response.data.access_token,
                refreshToken: response.data.refresh_token,
                expiresOn: Date.now() + (response.data.expires_in * 1000),
                sellerId: seller_id,
            };

            await this.storeTokens(seller_id, tokens);

            return {
                content: [{
                    type: 'text',
                    text: `Successfully authenticated with Myntra!\n\nSeller ID: ${seller_id}\nToken expires in: ${Math.floor(response.data.expires_in / 60)} minutes`
                }]
            };
        } catch (error: any) {
            return {
                content: [{
                    type: 'text',
                    text: `Authentication failed: ${error.response?.data?.message || error.message}`
                }],
                isError: true
            };
        }
    }

    private async handleStatus(sellerId: string) {
        if (!sellerId) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: seller_id is required'
                }],
                isError: true
            };
        }

        if (await this.checkAuthentication(sellerId)) {
            try {
                const data = await this.makeApiRequest(sellerId, 'GET', '/account/info');

                return {
                    content: [{
                        type: 'text',
                        text: `**Myntra Seller Account Connected**\n\nSeller ID: ${sellerId}\nSeller Name: ${data.seller_name || 'N/A'}\nStatus: ${data.status || 'Active'}\nAuthenticated: Yes`
                    }]
                };
            } catch (error) {
                return {
                    content: [{
                        type: 'text',
                        text: `Connected but unable to fetch details: ${(error as Error).message}`
                    }]
                };
            }
        } else {
            return {
                content: [{
                    type: 'text',
                    text: '**Not connected to Myntra**\n\nRun myntra_authenticate to get started.'
                }]
            };
        }
    }

    private async handleMyntraOperation(operation: string, args: any) {
        switch (operation) {
            case 'myntra_list_products':
                return await this.listProducts(args);
            case 'myntra_get_product':
                return await this.getProduct(args);
            case 'myntra_create_product':
                return await this.createProduct(args);
            case 'myntra_update_product':
                return await this.updateProduct(args);
            case 'myntra_update_inventory':
                return await this.updateInventory(args);
            case 'myntra_list_orders':
                return await this.listOrders(args);
            case 'myntra_get_order':
                return await this.getOrder(args);
            case 'myntra_update_order_status':
                return await this.updateOrderStatus(args);
            case 'myntra_get_returns':
                return await this.getReturns(args);
            case 'myntra_process_return':
                return await this.processReturn(args);
            case 'myntra_get_analytics':
                return await this.getAnalytics(args);
            default:
                throw new Error(`Unknown operation: ${operation}`);
        }
    }

    private async listProducts(args: any) {
        const { seller_id, status = 'all', category, limit = 50, offset = 0 } = args;

        const params = new URLSearchParams();
        if (status !== 'all') params.append('status', status);
        if (category) params.append('category', category);
        params.append('limit', limit.toString());
        params.append('offset', offset.toString());

        const data = await this.makeApiRequest(seller_id, 'GET', `/products?${params.toString()}`);

        const productList = data.products?.map((product: any) => {
            return `**${product.name}** (SKU: ${product.sku})\n   Brand: ${product.brand}\n   Category: ${product.category}\n   MRP: ₹${product.mrp} | Selling: ₹${product.selling_price}\n   Inventory: ${product.inventory} units\n   Status: ${product.status}\n   ID: ${product.id}`;
        }).join('\n\n') || 'No products found';

        return {
            content: [{
                type: 'text',
                text: `**Myntra Products** (${data.products?.length || 0} of ${data.total || 0})\n\n${productList}`
            }]
        };
    }

    private async getProduct(args: any) {
        const { seller_id, product_id } = args;

        const data = await this.makeApiRequest(seller_id, 'GET', `/products/${product_id}`);

        const info = [
            `**${data.name}**`,
            `SKU: ${data.sku}`,
            `Brand: ${data.brand}`,
            `Category: ${data.category}`,
            `Description: ${data.description || 'N/A'}`,
            `MRP: ₹${data.mrp}`,
            `Selling Price: ₹${data.selling_price}`,
            `Discount: ${Math.round(((data.mrp - data.selling_price) / data.mrp) * 100)}%`,
            `Inventory: ${data.inventory} units`,
            `Status: ${data.status}`,
            `Views: ${data.views || 0}`,
            `Orders: ${data.orders_count || 0}`,
            `Rating: ${data.rating || 'N/A'} (${data.reviews_count || 0} reviews)`,
        ];

        if (data.images?.length > 0) {
            info.push(`Images: ${data.images.length} uploaded`);
        }

        return {
            content: [{
                type: 'text',
                text: info.join('\n')
            }]
        };
    }

    private async createProduct(args: any) {
        const { seller_id, sku, name, brand, category, description, mrp, selling_price, inventory, images } = args;

        const productData = {
            sku,
            name,
            brand,
            category,
            description,
            mrp,
            selling_price,
            inventory,
            images: images || [],
        };

        const data = await this.makeApiRequest(seller_id, 'POST', '/products', productData);

        return {
            content: [{
                type: 'text',
                text: `**Product Created Successfully!**\n\nProduct: ${data.name}\nSKU: ${data.sku}\nID: ${data.id}\nStatus: ${data.status}\n\nNote: Product may need approval before going live.`
            }]
        };
    }

    private async updateProduct(args: any) {
        const { seller_id, product_id, updates } = args;

        const data = await this.makeApiRequest(seller_id, 'PATCH', `/products/${product_id}`, updates);

        const updatedFields = Object.keys(updates).join(', ');

        return {
            content: [{
                type: 'text',
                text: `**Product Updated!**\n\nProduct ID: ${product_id}\nUpdated fields: ${updatedFields}\nStatus: ${data.status}`
            }]
        };
    }

    private async updateInventory(args: any) {
        const { seller_id, product_id, quantity } = args;

        const data = await this.makeApiRequest(seller_id, 'PATCH', `/products/${product_id}/inventory`, {
            quantity
        });

        return {
            content: [{
                type: 'text',
                text: `**Inventory Updated!**\n\nProduct ID: ${product_id}\nNew Quantity: ${quantity} units\nUpdated: ${new Date().toLocaleString()}`
            }]
        };
    }

    private async listOrders(args: any) {
        const { seller_id, status = 'all', from_date, to_date, limit = 50 } = args;

        const params = new URLSearchParams();
        if (status !== 'all') params.append('status', status);
        if (from_date) params.append('from_date', from_date);
        if (to_date) params.append('to_date', to_date);
        params.append('limit', limit.toString());

        const data = await this.makeApiRequest(seller_id, 'GET', `/orders?${params.toString()}`);

        const orderList = data.orders?.map((order: any) => {
            return `**Order #${order.order_id}**\n   Customer: ${order.customer_name}\n   Product: ${order.product_name} (x${order.quantity})\n   Amount: ₹${order.total_amount}\n   Status: ${order.status}\n   Date: ${new Date(order.order_date).toLocaleDateString()}\n   Payment: ${order.payment_status}`;
        }).join('\n\n') || 'No orders found';

        return {
            content: [{
                type: 'text',
                text: `**Myntra Orders** (${data.orders?.length || 0} of ${data.total || 0})\n\n${orderList}`
            }]
        };
    }

    private async getOrder(args: any) {
        const { seller_id, order_id } = args;

        const data = await this.makeApiRequest(seller_id, 'GET', `/orders/${order_id}`);

        const info = [
            `**Order #${data.order_id}**`,
            `\n**Customer Details:**`,
            `Name: ${data.customer_name}`,
            `Phone: ${data.customer_phone}`,
            `Email: ${data.customer_email}`,
            `\n**Shipping Address:**`,
            `${data.shipping_address.line1}`,
            `${data.shipping_address.city}, ${data.shipping_address.state} - ${data.shipping_address.pincode}`,
            `\n**Order Details:**`,
            `Product: ${data.product_name}`,
            `SKU: ${data.product_sku}`,
            `Quantity: ${data.quantity}`,
            `Price: ₹${data.unit_price} x ${data.quantity} = ₹${data.subtotal}`,
            `Discount: -₹${data.discount || 0}`,
            `Shipping: ₹${data.shipping_charge || 0}`,
            `**Total Amount: ₹${data.total_amount}**`,
            `\n**Status:**`,
            `Order Status: ${data.status}`,
            `Payment Status: ${data.payment_status}`,
            `Order Date: ${new Date(data.order_date).toLocaleString()}`,
        ];

        if (data.tracking_id) {
            info.push(`Tracking ID: ${data.tracking_id}`);
            info.push(`Courier: ${data.courier_partner}`);
        }

        return {
            content: [{
                type: 'text',
                text: info.join('\n')
            }]
        };
    }

    private async updateOrderStatus(args: any) {
        const { seller_id, order_id, status, tracking_id, courier_partner } = args;

        const updateData: any = { status };
        if (tracking_id) updateData.tracking_id = tracking_id;
        if (courier_partner) updateData.courier_partner = courier_partner;

        const data = await this.makeApiRequest(seller_id, 'PATCH', `/orders/${order_id}/status`, updateData);

        return {
            content: [{
                type: 'text',
                text: `**Order Status Updated!**\n\nOrder ID: ${order_id}\nNew Status: ${status}\n${tracking_id ? `Tracking ID: ${tracking_id}\n` : ''}Updated: ${new Date().toLocaleString()}`
            }]
        };
    }

    private async getReturns(args: any) {
        const { seller_id, status = 'pending', limit = 25 } = args;

        const params = new URLSearchParams();
        if (status !== 'all') params.append('status', status);
        params.append('limit', limit.toString());

        const data = await this.makeApiRequest(seller_id, 'GET', `/returns?${params.toString()}`);

        const returnList = data.returns?.map((ret: any) => {
            return `**Return Request #${ret.return_id}**\n   Order: ${ret.order_id}\n   Product: ${ret.product_name}\n   Reason: ${ret.reason}\n   Status: ${ret.status}\n   Date: ${new Date(ret.request_date).toLocaleDateString()}\n   Amount: ₹${ret.refund_amount}`;
        }).join('\n\n') || 'No return requests found';

        return {
            content: [{
                type: 'text',
                text: `**Return Requests** (${data.returns?.length || 0} ${status} requests)\n\n${returnList}`
            }]
        };
    }

    private async processReturn(args: any) {
        const { seller_id, return_id, action, reason } = args;

        const requestData: any = { action };
        if (reason) requestData.reason = reason;

        const data = await this.makeApiRequest(seller_id, 'POST', `/returns/${return_id}/process`, requestData);

        return {
            content: [{
                type: 'text',
                text: `**Return Request ${action === 'approve' ? 'Approved' : 'Rejected'}!**\n\nReturn ID: ${return_id}\nAction: ${action}\n${reason ? `Reason: ${reason}\n` : ''}Processed: ${new Date().toLocaleString()}`
            }]
        };
    }

    private async getAnalytics(args: any) {
        const { seller_id, metric, from_date, to_date } = args;

        const params = new URLSearchParams();
        params.append('metric', metric);
        if (from_date) params.append('from_date', from_date);
        if (to_date) params.append('to_date', to_date);

        const data = await this.makeApiRequest(seller_id, 'GET', `/analytics?${params.toString()}`);

        let info: string[] = [];

        switch (metric) {
            case 'sales':
                info = [
                    `**Sales Analytics**`,
                    `Period: ${from_date || 'Start'} to ${to_date || 'Now'}`,
                    `\nTotal Sales: ₹${data.total_sales}`,
                    `Total Orders: ${data.total_orders}`,
                    `Average Order Value: ₹${data.average_order_value}`,
                    `Units Sold: ${data.units_sold}`,
                ];
                break;
            case 'orders':
                info = [
                    `**Order Analytics**`,
                    `Period: ${from_date || 'Start'} to ${to_date || 'Now'}`,
                    `\nTotal Orders: ${data.total_orders}`,
                    `Pending: ${data.pending_orders}`,
                    `Confirmed: ${data.confirmed_orders}`,
                    `Shipped: ${data.shipped_orders}`,
                    `Delivered: ${data.delivered_orders}`,
                    `Cancelled: ${data.cancelled_orders}`,
                    `Returned: ${data.returned_orders}`,
                ];
                break;
            case 'revenue':
                info = [
                    `**Revenue Analytics**`,
                    `Period: ${from_date || 'Start'} to ${to_date || 'Now'}`,
                    `\nGross Revenue: ₹${data.gross_revenue}`,
                    `Commission: -₹${data.commission}`,
                    `Shipping: -₹${data.shipping_cost}`,
                    `Returns/Refunds: -₹${data.refunds}`,
                    `**Net Revenue: ₹${data.net_revenue}**`,
                ];
                break;
            case 'top_products':
                const topProducts = data.top_products?.map((p: any, i: number) => 
                    `${i + 1}. ${p.name} - ${p.units_sold} units (₹${p.revenue})`
                ).join('\n   ') || 'No data';
                info = [
                    `**Top Products**`,
                    `Period: ${from_date || 'Start'} to ${to_date || 'Now'}`,
                    `\n   ${topProducts}`
                ];
                break;
            case 'inventory_health':
                info = [
                    `**Inventory Health**`,
                    `\nTotal Products: ${data.total_products}`,
                    `In Stock: ${data.in_stock}`,
                    `Low Stock: ${data.low_stock} (< 10 units)`,
                    `Out of Stock: ${data.out_of_stock}`,
                    `Average Stock Days: ${data.avg_stock_days} days`,
                ];
                break;
        }

        return {
            content: [{
                type: 'text',
                text: info.join('\n')
            }]
        };
    }

    async run() {
        const port = process.env.PORT || 9093;

        // Setup MCP SSE endpoint
        this.app.get('/mcp', (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');

            const transport = new SSEServerTransport('/mcp', res);
            this.server.connect(transport);
        });

        // Global error handler
        this.app.use((error: any, req: any, res: any, next: any) => {
            console.error('Global error handler:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
                timestamp: new Date().toISOString()
            });
        });

        // Start HTTP server
        this.app.listen(port, () => {
            console.log(`Myntra Seller MCP Server running on port ${port}`);
            console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`MCP endpoint: http://localhost:${port}/mcp`);
        });

        // Graceful shutdown
        process.on('SIGTERM', async () => {
            console.log('SIGTERM received, shutting down gracefully');
            if (this.redis) {
                await this.redis.disconnect();
            }
            process.exit(0);
        });

        process.on('SIGINT', async () => {
            console.log('SIGINT received, shutting down gracefully');
            if (this.redis) {
                await this.redis.disconnect();
            }
            process.exit(0);
        });
    }
}

// Start the server
const server = new MyntraSellerMCPServer();
server.run().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});