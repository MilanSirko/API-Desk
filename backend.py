import os
import time
import json
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Depends
from slowapi import _rate_limit_exceeded_handler, Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, FileResponse, Response
from pydantic import BaseModel, Field, EmailStr
from typing import Optional, Dict, Any, Literal
from supabase import create_client, Client
import httpx
import asyncio
from http.cookiejar import Cookie, DefaultCookiePolicy

load_dotenv()
BACKEND_URL = os.getenv('BACKEND_URL', '').rstrip('/')
FRONTEND_URL = os.getenv('FRONTEND_URL', '').rstrip('/')
if not BACKEND_URL or not FRONTEND_URL:
    raise RuntimeError('BACKEND_URL and FRONTEND_URL must be set in the environment.')
OAUTH_CALLBACK_URL = f'{BACKEND_URL}/api/auth/callback'
WORKSPACE_URL = f'{FRONTEND_URL}/api-tester.html'
PROJECT_ROOT = Path(__file__).resolve().parent
WEBSITE_ROOT = PROJECT_ROOT / 'website'
ASSET_ROOT = PROJECT_ROOT / 'assets'
bearer=HTTPBearer(auto_error=False)
app=FastAPI()
supabase_url = os.getenv('url')
supabase_service_key = os.getenv('service')
supabase: Client = create_client(supabase_url, supabase_service_key)
admin_supabase: Client = create_client(supabase_url, supabase_service_key)
app.add_middleware(CORSMiddleware, allow_credentials=True, allow_headers=['*'], allow_methods=['*'], allow_origins=[FRONTEND_URL])
limiter=Limiter(key_func=get_remote_address)
app.state.limiter=limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

class Sendrequest(BaseModel):
    method: str= 'GET'
    url: str
    headers: Dict= {}
    params: Dict= {}
    body: str=None
    timeout: float = Field(default=30, gt=0, le=60)
    followredirection: bool=True
    credentialsMode: Literal['same-origin', 'include', 'omit'] = 'same-origin'
    cookies: list[dict[str, Any]] = Field(default_factory=list, max_length=300)
    bodyType: str = "json"
    name: Optional[str]=None
    folderid: Optional[str]=None
    collectionid: Optional[str] = None

class User(BaseModel):
    email: EmailStr
    password: str=Field(...,min_length=6, max_length=100)

class Refreshtoken(BaseModel):
    refreshtoken: str

class Newfolder(BaseModel):
    name: str=Field(...,min_length=1, max_length=30)

class Editname(BaseModel):
    name: str=Field(...,min_length=1, max_length=30)

AuthType=Literal['none', 'bearer', 'basic', 'apikey']
class CollectionIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=30)
    headers: list = Field(default=[], max_length=50)
    variables: list = Field(default=[], max_length=50)
    authtype: AuthType = 'none'
    authconfig: dict = {}
    settings: dict = {}
    requestids: list[str] = Field(default_factory=list, max_length=100)

class Log(BaseModel):
    endpoint: str
    statuscode: int
    message: str

class RejectCookiesPolicy(DefaultCookiePolicy):
    def set_ok(self, cookie, request):
        return False

    def return_ok(self, cookie, request):
        return False

@app.post('/api/sendrequest')
@limiter.limit('100/min')
async def sendrequest(request: Request, body: Sendrequest):
    start=time.perf_counter()
    outgoing_headers = dict(body.headers)

    has_content_type = any(
        name.lower() == "content-type"
        for name in outgoing_headers
    )

    content_types = {
        "json": "application/json",
        "urlencoded": "application/x-www-form-urlencoded",
        "raw": "text/plain",
        "graphql": "application/graphql",
    }

    if body.body and not has_content_type:
        outgoing_headers["Content-Type"] = content_types.get(
            body.bodyType,
            "text/plain",
        )

    try:
        target_url = httpx.URL(body.url)
        page_origin = request.headers.get('origin') or FRONTEND_URL
        try:
            page_url = httpx.URL(page_origin)
            target_port = target_url.port or (443 if target_url.scheme == 'https' else 80)
            page_port = page_url.port or (443 if page_url.scheme == 'https' else 80)
            same_origin = (
                target_url.scheme == page_url.scheme
                and target_url.host == page_url.host
                and target_port == page_port
            )
        except httpx.InvalidURL:
            same_origin = False
        use_cookies = body.credentialsMode == 'include' or (
            body.credentialsMode == 'same-origin' and same_origin
        )
        async with httpx.AsyncClient(
            timeout=body.timeout,
            follow_redirects=body.followredirection,
        ) as client:
            if not use_cookies:
                client.cookies.jar.set_policy(RejectCookiesPolicy())
            if use_cookies:
                for item in body.cookies:
                    name = str(item.get('name', ''))
                    value = str(item.get('value', ''))
                    domain = str(item.get('domain', '')).lstrip('.').lower()
                    path = str(item.get('path') or '/')
                    expires = item.get('expires')
                    try:
                        expires_at = int(expires) if expires else None
                    except (TypeError, ValueError):
                        continue
                    if (
                        not name or any(char in name for char in ';=\r\n')
                        or any(char in value for char in '\r\n')
                        or not domain or not path.startswith('/')
                        or (expires_at and expires_at <= time.time())
                    ):
                        continue
                    rest = {}
                    if item.get('httpOnly'):
                        rest['HttpOnly'] = True
                    if item.get('sameSite'):
                        rest['SameSite'] = str(item['sameSite'])
                    client.cookies.jar.set_cookie(Cookie(
                        version=0,
                        name=name,
                        value=value,
                        port=None,
                        port_specified=False,
                        domain=domain,
                        domain_specified=not bool(item.get('hostOnly', True)),
                        domain_initial_dot=not bool(item.get('hostOnly', True)),
                        path=path,
                        path_specified=True,
                        secure=bool(item.get('secure')),
                        expires=expires_at,
                        discard=not bool(expires_at),
                        comment=None,
                        comment_url=None,
                        rest=rest,
                        rfc2109=False,
                    ))

            req = await client.request(
                method=body.method,
                url=body.url,
                headers=outgoing_headers,
                params=body.params,
                content=body.body or None,
            )
            cookies = []
            if use_cookies:
                for cookie in client.cookies.jar:
                    if len(cookies) >= 300:
                        break
                    cookies.append({
                        'name': cookie.name,
                        'value': cookie.value,
                        'domain': cookie.domain.lstrip('.').lower(),
                        'hostOnly': not cookie.domain_specified,
                        'path': cookie.path or '/',
                        'secure': cookie.secure,
                        'httpOnly': cookie.has_nonstandard_attr('HttpOnly'),
                        'sameSite': cookie.get_nonstandard_attr('SameSite'),
                        'expires': cookie.expires,
                    })
            else:
                cookies = body.cookies
    except (httpx.HTTPError, httpx.InvalidURL) as e:
        raise HTTPException(status_code=502, detail=str(e)) 
    ms= round((time.perf_counter() - start)* 1000)
    try:
        data=req.json()
    except ValueError:
        data=None

    return {
        'status': req.status_code,
        'reason': req.reason_phrase,
        'time': ms,
        'size': len(req.content),
        'finalurl': str(req.url),
        'headers': dict(req.headers),
        'cookies': cookies,
        'text': req.text,
        'json': data
    }

@app.post('/api/auth/register')
@limiter.limit('10/minute')
async def register(request: Request, body: User):
    try:
        supabase.auth.sign_up({
            'email': body.email,
            'password': body.password,
            'options': {'email_redirect_to': f'{FRONTEND_URL}/email-verified.html'},
        })
        return {'message': 'Check your inbox to confim!'}
    except Exception as e:
        print(str(e))
        raise HTTPException(status_code=500, detail='Registration failed')

@app.post('/api/auth/login')
@limiter.limit('10/minute')
async def login(request: Request, body: User):
    try:
        response=supabase.auth.sign_in_with_password({'email': body.email, 'password': body.password})
        return {'accestoken': response.session.access_token, 'tefreshtoken': response.session.refresh_token}
    except Exception:
        raise HTTPException(status_code=500, detail='Invalid email or password')

@app.post('/api/auth/logout')
@limiter.limit('10/minute')
async def logout(request: Request, body: Refreshtoken, cred: HTTPAuthorizationCredentials | None=Depends(bearer)):
    try:
        supabase.auth.set_session(cred.credentials, body.refreshtoken)
        supabase.auth.sign_out({'scope': 'local'})
    except Exception:
        pass
    return {'message': 'Logged out'}

@app.post('/api/auth/refresh')
@limiter.limit('10/minute')
async def refresh(request: Request, body: Refreshtoken):
    try:
        response=supabase.auth.refresh_session(body.refreshtoken).session
    except Exception:
        raise HTTPException(status_code=401, detail="Session expired")
    return {'accestoken': response.access_token, 'resfreshtoken': response.refresh_token}

async def getuser(cred: HTTPAuthorizationCredentials | None=Depends(bearer)):
    try:
        if not cred:
            raise HTTPException(status_code=401, detail="Not logged in")
        user=supabase.auth.get_user(cred.credentials).user
    except Exception:
        raise HTTPException(status_code=401, detail="Session expired")
    if user is None:
        raise HTTPException(status_code=401, detail="Session expired")
    return {'id': user.id, 'email': user.email, 'created': getattr(user, 'created_at', None)}

@app.get('/api/auth/oauth/{provider}')
@limiter.limit('10/minute')
async def oauth(request: Request, provider: Literal['google', 'github']):
    response=supabase.auth.sign_in_with_oauth({
        'provider': provider,
        'options': {'redirect_to': OAUTH_CALLBACK_URL},
    })
    return RedirectResponse(response.url)

@app.get('/api/auth/callback')
@limiter.limit('10/minute')
async def callback(request: Request, code: str | None = None):
    fall=RedirectResponse(f'{WORKSPACE_URL}?auth_error=1', status_code=303)
    if not code:
        return fall
    try:
        out=supabase.auth.exchange_code_for_session({'auth_code': code})
        session = out.session
        if not session or not session.access_token or not session.refresh_token:
            return fall
    except Exception:
        return fall
    return RedirectResponse(f'{WORKSPACE_URL}#access_token={session.access_token}&refresh_token={session.refresh_token}',
        status_code=303)

@app.get('/api/folders', status_code=200)
@limiter.limit('50/minute')
async def getfolders(request: Request, user=Depends(getuser)):
    userid=user['id']
    try:
        response=supabase.table('apifolders').select('*').eq('userid', userid).execute()
        if not response.data:
            return []
        return response.data
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.post('/api/folders/add', status_code=201)
@limiter.limit('50/minute')
async def addfolder(request: Request, body: Newfolder, user=Depends(getuser)):
    userid=user['id']
    try:
        response=supabase.table('apifolders').insert({'name': body.name, 'userid': userid}).execute()
        if not response.data:
            raise HTTPException(status_code=400, detail="Server error")
        return response.data
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.patch('/api/folders/edit/{id}', status_code=204)
@limiter.limit('50/minute')
async def editname(request: Request, body: Editname, id: str, user=Depends(getuser)):
    userid=user['id']
    try:
        response=supabase.table('apifolders').update({'name': body.name}).eq('id', id).eq('userid', userid).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="id dosen't exist")
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.delete('/api/folders/delete/{id}', status_code=204)
@limiter.limit('50/minute')
async def deleteforder(request: Request, id: str, user=Depends(getuser)):
    userid=user['id']
    try:
        response=supabase.table('apifolders').delete().eq('id', id).eq('userid', userid).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="id dosen't exist")
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.post('/api/folders/addrequest/{folderid}', status_code=200)
@limiter.limit('50/minute')
async def addrequesttofolder(request: Request, folderid: str, body: Sendrequest, user=Depends(getuser)):
    userid=user['id']
    try:
        insertdata={
            'userid': userid,
            'folderid': folderid,
            'name': body.name,
            'method': body.method,
            'url': body.url,
            'params': body.params,
            'headers': body.headers,
            'bodytype': body.bodyType,
            'body': body.body,
        }
        response=supabase.table('requests').insert(insertdata).execute()
        if not response.data:
            raise HTTPException(status_code=400, detail="Database error")
        return response.data[0]
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.get('/api/requests', status_code=200)
@limiter.limit('50/minute')
async def getallrequest(request: Request,folderid: Optional[str]=None,collectionid: Optional[str] = None, user=Depends(getuser)):
    userid=user['id']
    try:
        response=supabase.table('requests').select('*').eq('userid', userid)
        
        if collectionid and collectionid.lower() != 'null':
            response=response.eq('collectionid', collectionid).is_('folderid', 'null')

        elif folderid and folderid.lower() != 'null':
            response=response.eq('folderid', folderid).is_('collectionid', 'null')

        else:
            response=response.is_('folderid', 'null').is_('collectionid', 'null')

        response=response.execute()
        if not response.data:
            return []
        return response.data
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.post('/api/request/add', status_code=201)
@limiter.limit('50/minute')
async def saverequest(request: Request,body: Sendrequest ,user=Depends(getuser)):
    userid=user['id']
    try:
        insertdata={
            'userid': userid,
            'folderid': body.folderid,
            'name': body.name,
            'method': body.method,
            'url': body.url,
            'params': body.params,
            'headers': body.headers,
            'bodytype': body.bodyType,
            'body': body.body,
            'collectionid': body.collectionid,
        }
        response=supabase.table('requests').insert(insertdata).execute()
        if not response.data:
            raise HTTPException(status_code=400, detail="Database error")
        return response.data[0]
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.patch('/api/request/rename/{requestid}', status_code=204)
@limiter.limit('50/minute')
async def renamerequest(request: Request, requestid: str,body: Editname, user=Depends(getuser)):
    userid=user['id']
    try:
        response=supabase.table('requests').update({'name': body.name}).eq('userid', userid).eq('id', requestid).execute()
        if not response.data:
            raise HTTPException(status_code=400, detail="Database error")
        return response.data[0]
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.delete('/api/request/delete/{requestid}', status_code=204)
async def deleterequest(request: Request, requestid: str, user=Depends(getuser)):
    userid=user['id']
    try:
        supabase.table('requests').delete().eq('userid', userid).eq('id', requestid).execute()
    except Exception:
        raise HTTPException(status_code=500, detail="Server error") 

@app.get('/api/collections', status_code=200)
@limiter.limit('50/minute')
async def getallcollections(request: Request, user=Depends(getuser)):
    userid=user['id']
    try:
        response=supabase.table('collections').select('*').eq('userid', userid).execute()
        if not response.data:
            return []
        return response.data
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.post("/api/addcollection", status_code=201)
@limiter.limit('50/minute')
async def addcollections(
    request: Request,
    body: CollectionIn,
    user=Depends(getuser),
):
    userid=user["id"]
    try:
        result = supabase.table("collections").insert({
            "userid": userid,
            "name": body.name,
            "headers": body.headers,
            "variables": body.variables,
            "authtype": body.authtype,
            "authconfig": body.authconfig,
            "settings": body.settings,
        }).execute()
        collection=result.data[0]
        for request_id in body.requestids:
            source = (
                supabase.table("requests")
                .select("*")
                .eq("id", request_id)
                .eq("userid", userid)
                .execute()
            )
            if source.data:
                old = source.data[0]
                supabase.table("requests").insert({
                    "userid": userid,
                    "folderid": None,
                    "collectionid": collection["id"],
                    "name": old["name"],
                    "method": old["method"],
                    "url": old["url"],
                    "params": old["params"],
                    "headers": old["headers"],
                    "bodytype": old["bodytype"],
                    "body": old["body"],
                }).execute()
        return collection
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.delete('/api/collections/delete/{id}', status_code=204)
@limiter.limit('50/minute')
async def deletecollection(request: Request, id: str, user=Depends(getuser)):
    userid=user["id"]
    try:
        response=supabase.table('collections').delete().eq('userid', userid).eq('id', id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Id not found")
        return response.data[0]
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.patch('/api/collections/update={id}', status_code=204)
@limiter.limit('50/minute')
async def update(request: Request, id: str, new: CollectionIn, user=Depends(getuser)):
    userid=user["id"]
    newdates={
        "userid": userid,
        "name": new.name,
        "headers": new.headers,
        "variables": new.variables,
        "authtype": new.authtype,
        "authconfig": new.authconfig,
        "settings": new.settings,
    }
    try:
        response=supabase.table('collections').update(newdates).eq('userid', userid).eq('id', id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Id not found")
        return response.data[0]
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.get('/api/user', status_code=200)
@limiter.limit('50/minute')
async def user(request: Request, user=Depends(getuser)):
    try:
        return{
            'userid': user['id'],
            'email': user['email'],
            'created': user['created']
        }
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")

@app.get('/api/user/logs', status_code=200)
@limiter.limit('50/minute')
async def getlogs(request: Request, user=Depends(getuser)):
    userid=user["id"]
    try:
        response=(
            supabase.table('logs')
            .select('*')
            .eq('userid', userid)
            .order('created', desc=True)
            .limit(50)
            .execute()
        )
        return response.data or []
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not load logs: {e}")

@app.post('/api/user/logs/add', status_code=201)
@limiter.limit('100/minute')
async def addlogs(request: Request, body: Log, user=Depends(getuser)):
    userid=user["id"]
    try:
        insertlog={
            'userid': userid,
            'endpoint': body.endpoint,
            'statuscode': body.statuscode,
            'message': body.message
        }
        response=supabase.table('logs').insert(insertlog).execute()
        if not response.data:
            raise HTTPException(status_code=400, detail='Database error')
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not save log: {e}")

@app.delete('/api/users/delete', status_code=200)
@limiter.limit('10/minute')
async def deleteuser(request: Request, user=Depends(getuser)):
    userid=user["id"]
    try:
        admin_supabase.auth.admin.delete_user(userid)
    except Exception as e:
        print(str(e))
        raise HTTPException(status_code=500, detail="Server error")

        
@app.get('/root')
async def root(request: Request):
    try:
        return {"Server are running"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error: {str(e)}")

@app.get('/runtime-config.js', include_in_schema=False)
async def runtime_config():
    public_config = json.dumps({'backendUrl': BACKEND_URL})
    return Response(
        content=f'window.APIDESK_CONFIG = Object.freeze({public_config});',
        media_type='application/javascript',
        headers={'Cache-Control': 'no-store'},
    )

@app.get('/{asset_path:path}', include_in_schema=False)
async def serve_frontend(asset_path: str = ''):
    relative_path = asset_path or 'index.html'
    requested_path = Path(relative_path)
    allowed_extensions = {
        '.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.webp',
        '.svg', '.ico', '.woff', '.woff2', '.webmanifest', '.xml', '.txt',
    }
    if any(part.startswith('.') for part in requested_path.parts):
        raise HTTPException(status_code=404, detail='Not found')
    if requested_path.parts and requested_path.parts[0].lower() == 'assets':
        static_root = ASSET_ROOT
        relative_asset = Path(*requested_path.parts[1:])
        file_path = (static_root / relative_asset).resolve()
    else:
        static_root = WEBSITE_ROOT
        file_path = (static_root / requested_path).resolve()
    if (
        static_root not in file_path.parents
        or file_path.suffix.lower() not in allowed_extensions
        or not file_path.is_file()
    ):
        raise HTTPException(status_code=404, detail='Not found')
    return FileResponse(file_path)

