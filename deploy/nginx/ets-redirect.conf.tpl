# ETS — HTTP → HTTPS redirect (appended to the site when a redirect port is chosen).
# Placeholders: __SERVER_NAME__ __HTTP_PORT__ __REDIRECT_TARGET__

server {
    listen __HTTP_PORT__;
    listen [::]:__HTTP_PORT__;
    server_name __SERVER_NAME__;

    # Let's Encrypt renewals (certbot --webroot)
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }

    location / { return 301 __REDIRECT_TARGET__$request_uri; }
}
