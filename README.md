**Myntra Seller MCP Server**

A middleware MCP (Model Context Protocol) server for integrating and automating operations with the Myntra Seller API. This server allows seller dashboard automation, product catalog management, order handling, and inventory updates via structured tool endpoints.

**Features**

Secure Authentication with Myntra Seller API using Seller ID, API Key, and Secret

Account Status: Check connection and status of your seller account

Product Catalog: List, view, create, update products; manage inventory and pricing

Order Management: List, view, update status, and track orders

Returns Handling: List return requests, approve/reject returns, view details

Analytics & Reports: Fetch sales, revenue, and inventory metrics

In-memory Token Management for seller authentication

Extensible Tool API via ModelContextProtocol SDK


**Tool Endpoints**

The MCP server exposes structured tool endpoints for programmatic use:

**Authentication & Account**

myntra_authenticate: Authenticate with Seller ID, API Key, Secret

myntra_status: Check seller account connection and health

**Product Catalog**

myntra_list_products: List products with filtering (status, category, pagination)

myntra_get_product: Get details for a specific product

myntra_create_product: Create a product listing (with details and images)

myntra_update_product: Update information of an existing product

myntra_update_inventory: Modify inventory for a product

**Orders**

myntra_list_orders: List orders with status/date filters

myntra_get_order: View details for a particular order

myntra_update_order_status: Update status, mark as shipped/cancelled, add tracking info

**Returns**

myntra_get_returns: List return requests with status filter

myntra_process_return: Approve or reject a return request

**Analytics**

myntra_get_analytics: Retrieve sales, orders, revenue, top products, or inventory health metrics
