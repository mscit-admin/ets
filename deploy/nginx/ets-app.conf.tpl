# ETS — shared locations, installed to /etc/nginx/snippets/ets-app.conf by deploy/install.sh.
# Placeholder: __API_PORT__

access_log /var/log/nginx/ets.access.log;
error_log  /var/log/nginx/ets.error.log;

client_max_body_size 6m;
gzip on;
gzip_types text/css application/javascript application/json image/svg+xml;

root /opt/ets/frontend/dist;
index index.html;

# API → Node.js backend
location /api/ {
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}

# Brute-force protection on every endpoint that checks a password, 2FA code or recovery code.
# Case-insensitive and with an optional trailing slash, like the API's own routing (ETS-SEC-003).
location ~* ^/api/auth/(login|change-password|2fa/(verify|setup|enable|disable|recovery-codes))/?$ {
    limit_req zone=ets_login burst=5 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# Hashed static assets: cache for a long time
location /assets/ {
    expires 30d;
    add_header Cache-Control "public, immutable";
    try_files $uri =404;
}

# Single-page app: every other path serves index.html
location / {
    add_header Cache-Control "no-cache";
    try_files $uri /index.html;
}
