#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
class MyntraSellerMCPServer {
    server;
    sellerTokens = new Map();
    myntraApiBase;
    constructor() {
        this.myntraApiBase = process.env.MYNTRA_API_BASE || 'https://api.myntra.com/seller';
        this.server = new Server({
            name: 'myntra-seller-mcp-server',
            version: '1.0.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.setupToolHandlers();
    }
    async storeTokens(sellerId, tokens) {
        this.sellerTokens.set(sellerId, tokens);
    }
    async getTokens(sellerId) {
        return this.sellerTokens.get(sellerId) || null;
    }
    async revokeTokens(sellerId) {
        this.sellerTokens.delete(sellerId);
    }
    async checkAuthentication(sellerId) {
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
                const updatedTokens = {
                    accessToken: response.data.access_token,
                    refreshToken: response.data.refresh_token || tokens.refreshToken,
                    expiresOn: Date.now() + (response.data.expires_in * 1000),
                    sellerId: sellerId,
                };
                await this.storeTokens(sellerId, updatedTokens);
                return true;
            }
            catch (error) {
                console.error('Token refresh failed:', error);
                await this.revokeTokens(sellerId);
            }
        }
        return false;
    }
    async makeApiRequest(sellerId, method, endpoint, data) {
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
        }
        catch (error) {
            throw new Error(error.response?.data?.message || error.message);
        }
    }
    setupToolHandlers() {
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                status: {
                                    type: 'string',
                                    enum: ['active', 'inactive', 'pending', 'rejected', 'all'],
                                    description: 'Filter by product status',
                                    default: 'all'
                                },
                                category: { type: 'string', description: 'Filter by category' },
                                limit: { type: 'number', description: 'Maximum products to return', default: 50 },
                                offset: { type: 'number', description: 'Offset for pagination', default: 0 },
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                product_id: { type: 'string', description: 'Product SKU or ID' },
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                sku: { type: 'string', description: 'Product SKU' },
                                name: { type: 'string', description: 'Product name' },
                                brand: { type: 'string', description: 'Brand name' },
                                category: { type: 'string', description: 'Product category' },
                                description: { type: 'string', description: 'Product description' },
                                mrp: { type: 'number', description: 'Maximum Retail Price' },
                                selling_price: { type: 'number', description: 'Selling price' },
                                inventory: { type: 'number', description: 'Available inventory' },
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                product_id: { type: 'string', description: 'Product SKU or ID' },
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                product_id: { type: 'string', description: 'Product SKU or ID' },
                                quantity: { type: 'number', description: 'New inventory quantity' },
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                status: {
                                    type: 'string',
                                    enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned', 'all'],
                                    description: 'Filter by order status',
                                    default: 'all'
                                },
                                from_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
                                to_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
                                limit: { type: 'number', description: 'Maximum orders to return', default: 50 },
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                order_id: { type: 'string', description: 'Order ID' },
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                order_id: { type: 'string', description: 'Order ID' },
                                status: {
                                    type: 'string',
                                    enum: ['ready_to_ship', 'shipped', 'cancelled'],
                                    description: 'New order status'
                                },
                                tracking_id: { type: 'string', description: 'Tracking ID (required for shipped status)' },
                                courier_partner: { type: 'string', description: 'Courier partner name' },
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                status: {
                                    type: 'string',
                                    enum: ['pending', 'approved', 'rejected', 'completed', 'all'],
                                    description: 'Filter by return status',
                                    default: 'pending'
                                },
                                limit: { type: 'number', description: 'Maximum returns to return', default: 25 },
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                return_id: { type: 'string', description: 'Return request ID' },
                                action: {
                                    type: 'string',
                                    enum: ['approve', 'reject'],
                                    description: 'Action to take'
                                },
                                reason: { type: 'string', description: 'Reason for rejection (if applicable)' },
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
                                seller_id: { type: 'string', description: 'Seller ID' },
                                metric: {
                                    type: 'string',
                                    enum: ['sales', 'orders', 'revenue', 'top_products', 'inventory_health'],
                                    description: 'Metric to retrieve',
                                    default: 'sales'
                                },
                                from_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
                                to_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
                            },
                            required: ['seller_id', 'metric']
                        }
                    },
                ]
            };
        });
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const sellerId = args?.seller_id;
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
            }
            catch (error) {
                console.error(`Error in ${name}:`, error);
                throw new McpError(ErrorCode.InternalError, `Error executing ${name}: ${error.message}`);
            }
        });
    }
    async handleAuthenticate(args) {
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
            if (await this.checkAuthentication(seller_id)) {
                return {
                    content: [{
                            type: 'text',
                            text: `Already authenticated with Myntra!\n\nSeller ID: ${seller_id}`
                        }]
                };
            }
            const response = await axios.post(`${this.myntraApiBase}/auth/token`, {
                seller_id,
                api_key,
                api_secret,
            });
            const tokens = {
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
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Authentication failed: ${error.response?.data?.message || error.message}`
                    }],
                isError: true
            };
        }
    }
    async handleStatus(sellerId) {
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
            }
            catch (error) {
                return {
                    content: [{
                            type: 'text',
                            text: `Connected but unable to fetch details: ${error.message}`
                        }]
                };
            }
        }
        else {
            return {
                content: [{
                        type: 'text',
                        text: '**Not connected to Myntra**\n\nRun myntra_authenticate to get started.'
                    }]
            };
        }
    }
    async handleMyntraOperation(operation, args) {
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
    async listProducts(args) {
        const { seller_id, status = 'all', category, limit = 50, offset = 0 } = args;
        const params = new URLSearchParams();
        if (status !== 'all')
            params.append('status', status);
        if (category)
            params.append('category', category);
        params.append('limit', limit.toString());
        params.append('offset', offset.toString());
        const data = await this.makeApiRequest(seller_id, 'GET', `/products?${params.toString()}`);
        const productList = data.products?.map((product) => {
            return `**${product.name}** (SKU: ${product.sku})\n   Brand: ${product.brand}\n   Category: ${product.category}\n   MRP: ₹${product.mrp} | Selling: ₹${product.selling_price}\n   Inventory: ${product.inventory} units\n   Status: ${product.status}\n   ID: ${product.id}`;
        }).join('\n\n') || 'No products found';
        return {
            content: [{
                    type: 'text',
                    text: `**Myntra Products** (${data.products?.length || 0} of ${data.total || 0})\n\n${productList}`
                }]
        };
    }
    async getProduct(args) {
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
    async createProduct(args) {
        const { seller_id, sku, name, brand, category, description, mrp, selling_price, inventory, images } = args;
        const productData = {
            sku, name, brand, category, description, mrp, selling_price, inventory,
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
    async updateProduct(args) {
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
    async updateInventory(args) {
        const { seller_id, product_id, quantity } = args;
        const data = await this.makeApiRequest(seller_id, 'PATCH', `/products/${product_id}/inventory`, { quantity });
        return {
            content: [{
                    type: 'text',
                    text: `**Inventory Updated!**\n\nProduct ID: ${product_id}\nNew Quantity: ${quantity} units\nUpdated: ${new Date().toLocaleString()}`
                }]
        };
    }
    async listOrders(args) {
        const { seller_id, status = 'all', from_date, to_date, limit = 50 } = args;
        const params = new URLSearchParams();
        if (status !== 'all')
            params.append('status', status);
        if (from_date)
            params.append('from_date', from_date);
        if (to_date)
            params.append('to_date', to_date);
        params.append('limit', limit.toString());
        const data = await this.makeApiRequest(seller_id, 'GET', `/orders?${params.toString()}`);
        const orderList = data.orders?.map((order) => {
            return `**Order #${order.order_id}**\n   Customer: ${order.customer_name}\n   Product: ${order.product_name} (x${order.quantity})\n   Amount: ₹${order.total_amount}\n   Status: ${order.status}\n   Date: ${new Date(order.order_date).toLocaleDateString()}\n   Payment: ${order.payment_status}`;
        }).join('\n\n') || 'No orders found';
        return {
            content: [{
                    type: 'text',
                    text: `**Myntra Orders** (${data.orders?.length || 0} of ${data.total || 0})\n\n${orderList}`
                }]
        };
    }
    async getOrder(args) {
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
    async updateOrderStatus(args) {
        const { seller_id, order_id, status, tracking_id, courier_partner } = args;
        const updateData = { status };
        if (tracking_id)
            updateData.tracking_id = tracking_id;
        if (courier_partner)
            updateData.courier_partner = courier_partner;
        const data = await this.makeApiRequest(seller_id, 'PATCH', `/orders/${order_id}/status`, updateData);
        return {
            content: [{
                    type: 'text',
                    text: `**Order Status Updated!**\n\nOrder ID: ${order_id}\nNew Status: ${status}\n${tracking_id ? `Tracking ID: ${tracking_id}\n` : ''}Updated: ${new Date().toLocaleString()}`
                }]
        };
    }
    async getReturns(args) {
        const { seller_id, status = 'pending', limit = 25 } = args;
        const params = new URLSearchParams();
        if (status !== 'all')
            params.append('status', status);
        params.append('limit', limit.toString());
        const data = await this.makeApiRequest(seller_id, 'GET', `/returns?${params.toString()}`);
        const returnList = data.returns?.map((ret) => {
            return `**Return Request #${ret.return_id}**\n   Order: ${ret.order_id}\n   Product: ${ret.product_name}\n   Reason: ${ret.reason}\n   Status: ${ret.status}\n   Date: ${new Date(ret.request_date).toLocaleDateString()}\n   Amount: ₹${ret.refund_amount}`;
        }).join('\n\n') || 'No return requests found';
        return {
            content: [{
                    type: 'text',
                    text: `**Return Requests** (${data.returns?.length || 0} ${status} requests)\n\n${returnList}`
                }]
        };
    }
    async processReturn(args) {
        const { seller_id, return_id, action, reason } = args;
        const requestData = { action };
        if (reason)
            requestData.reason = reason;
        const data = await this.makeApiRequest(seller_id, 'POST', `/returns/${return_id}/process`, requestData);
        return {
            content: [{
                    type: 'text',
                    text: `**Return Request ${action === 'approve' ? 'Approved' : 'Rejected'}!**\n\nReturn ID: ${return_id}\nAction: ${action}\n${reason ? `Reason: ${reason}\n` : ''}Processed: ${new Date().toLocaleString()}`
                }]
        };
    }
    async getAnalytics(args) {
        const { seller_id, metric, from_date, to_date } = args;
        const params = new URLSearchParams();
        params.append('metric', metric);
        if (from_date)
            params.append('from_date', from_date);
        if (to_date)
            params.append('to_date', to_date);
        const data = await this.makeApiRequest(seller_id, 'GET', `/analytics?${params.toString()}`);
        let info = [];
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
                const topProducts = data.top_products?.map((p, i) => `${i + 1}. ${p.name} - ${p.units_sold} units (₹${p.revenue})`).join('\n   ') || 'No data';
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
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Myntra Seller MCP Server running on stdio');
    }
}
// Start the server
const server = new MyntraSellerMCPServer();
server.run().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map