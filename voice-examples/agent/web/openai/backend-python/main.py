#!/usr/bin/env python3
"""
XAI Realtime Voice API - Web Backend (Python) - OpenAI-Compatible

A FastAPI server that provides ephemeral tokens for direct client-to-XAI connections.
No WebSocket proxying - clients connect directly to XAI's realtime API.
"""

import os
from datetime import datetime

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# Load environment variables
load_dotenv()

# Configuration
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or os.getenv("XAI_API_KEY")
# Bind to loopback by default; set HOST=0.0.0.0 to expose on all interfaces
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
SESSION_REQUEST_URL = "https://api.x.ai/v1/realtime/client_secrets"

# Voice and instructions for frontend configuration
VOICE = os.getenv("VOICE", "ara")
INSTRUCTIONS = os.getenv(
    "INSTRUCTIONS",
    "You are a helpful voice assistant. You are speaking to a user in real-time over audio. Keep your responses conversational and concise since they will be spoken aloud.",
)

# CORS Configuration
ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:3000,http://localhost:5173,http://localhost:8080",
).split(",")

# FastAPI app
app = FastAPI(
    title="XAI Voice Web Backend",
    description="Ephemeral token provider for XAI realtime voice API (OpenAI-Compatible)",
    version="2.0.0",
)

# Rate limiting
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========================================
# REST API Endpoints
# ========================================


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "XAI Voice Web Backend (Python)",
        "provider": "XAI",
        "version": "2.0.0",
        "status": "running",
        "endpoints": {
            "health": "/health",
            "session": "/session",
        },
    }


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "provider": "XAI",
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.post("/session")
@limiter.limit("10/minute")
async def create_session(request: Request):
    """
    Get ephemeral token for direct XAI API connection
    POST /session
    """
    try:
        print("📝 Creating ephemeral session...")

        async with httpx.AsyncClient() as client:
            response = await client.post(
                SESSION_REQUEST_URL,
                headers={
                    "Authorization": f"Bearer {OPENAI_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={"expires_after": {"seconds": 300}},
            )

        if response.status_code != 200:
            # Upstream details stay in the server log; callers get a generic error
            print(f"❌ Failed to get ephemeral token: {response.status_code} {response.text}")
            return JSONResponse(
                status_code=502,
                content={"error": "Failed to create session"},
            )

        data = response.json()
        print("✅ Ephemeral session created")

        # Transform to match client's expected format (OpenAI-compatible)
        return {
            "client_secret": {
                "value": data["value"],
                "expires_at": data["expires_at"],
            },
            "voice": VOICE,
            "instructions": INSTRUCTIONS,
        }

    except Exception as e:
        print(f"❌ Error creating session: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to create session"},
        )


# ========================================
# Startup & Shutdown Events
# ========================================


@app.on_event("startup")
async def startup_event():
    """Run on server startup"""
    print("=" * 60)
    print("🚀 XAI Voice Web Backend (Python)")
    print("   OpenAI SDK Compatible")
    print("=" * 60)
    print(f"🌐 Host: {HOST}")
    print(f"🌐 Port: {PORT}")
    print(f"🔑 API Key: {'Configured' if OPENAI_API_KEY else '❌ Missing'}")
    print(f"🎙️  Voice: {VOICE}")
    print(f"📝 Instructions: {INSTRUCTIONS[:50]}...")
    print(f"🔒 CORS Origins: {', '.join(ALLOWED_ORIGINS)}")
    print("=" * 60)

    if not OPENAI_API_KEY:
        print("⚠️  WARNING: XAI_API_KEY or OPENAI_API_KEY not configured!")


@app.on_event("shutdown")
async def shutdown_event():
    """Run on server shutdown"""
    print("\n👋 Shutting down XAI Voice Web Backend")


# ========================================
# Main Entry Point
# ========================================

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        log_level="info",
        reload=False,
    )
