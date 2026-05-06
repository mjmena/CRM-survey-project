import os
import sys
import json
import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

app = Server("prism-mcp-wrapper")

WEBHOOK_URL = "https://eombzorv24mjje6.m.pipedream.net"
ACCESS_TOKEN = os.environ.get("PIPEDREAM_ACCESS_TOKEN")

@app.list_tools()
async def list_tools() -> list[Tool]:
    headers = {"Content-Type": "application/json"}
    if ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {ACCESS_TOKEN}"
        
    payload = {
        "jsonrpc": "2.0",
        "id": "list-req",
        "method": "tools/list",
        "params": {}
    }
    
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(WEBHOOK_URL, json=payload, headers=headers, timeout=10.0)
            resp.raise_for_status()
            data = resp.json()
            tools_data = data.get("result", {}).get("tools", [])
            
            tools = []
            for t in tools_data:
                tools.append(Tool(
                    name=t.get("name"),
                    description=t.get("description", ""),
                    inputSchema=t.get("inputSchema", {})
                ))
            return tools
        except Exception as e:
            print(f"Error fetching tools from Pipedream: {e}", file=sys.stderr)
            return []

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    headers = {"Content-Type": "application/json"}
    if ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {ACCESS_TOKEN}"
        
    payload = {
        "jsonrpc": "2.0",
        "id": "call-req",
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments
        }
    }
    
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(WEBHOOK_URL, json=payload, headers=headers, timeout=60.0)
            resp.raise_for_status()
            data = resp.json()
            
            if "error" in data:
                raise ValueError(f"Tool execution failed: {json.dumps(data['error'])}")
                
            result = data.get("result", {})
            
            if "content" in result:
                content_items = result["content"]
                out = []
                for item in content_items:
                    out.append(TextContent(type="text", text=item.get("text", "")))
                return out
            else:
                return [TextContent(type="text", text=json.dumps(result))]
                
        except Exception as e:
            print(f"Error calling tool {name}: {e}", file=sys.stderr)
            raise ValueError(f"Error calling tool {name}: {str(e)}")

async def main():
    if not ACCESS_TOKEN:
        print("Warning: PIPEDREAM_ACCESS_TOKEN is not set.", file=sys.stderr)
        
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
