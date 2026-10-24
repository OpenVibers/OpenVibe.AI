'use strict';
// deploy/nginx/ai.openvibe.services.conf: the catch-all hands GET/HEAD to the app, so browsers get its /favicon.ico and
// its own 404 page (with lang and the Frame) instead of nginx's bare page; every other method is refused at nginx.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'ai.openvibe.services.conf'), 'utf8');
const catchAll = conf.slice(conf.lastIndexOf('    location / {'));
assert.match(catchAll, /limit_except GET HEAD \{ deny all; \}/, 'the catch-all only passes GET and HEAD');
assert.match(catchAll, /proxy_pass http:\/\/127\.0\.0\.1:4700;/, 'and lets the app answer (favicon, 404 page)');
assert.ok(!/location \/ \{\s*return 404;\s*\}/.test(conf), "nginx's bare 404 page (no lang) is gone");
assert.match(conf, /location ~\* \^\/metrics\(\/\|\$\) \{ return 404; \}/, '/metrics stays refused');
const reports = /location = \/release-metrics \{([\s\S]*?)\n    \}/.exec(conf);
assert.ok(reports && /limit_except POST \{ deny all; \}/.test(reports[1]) && /proxy_pass http:\/\/127\.0\.0\.1:4700;/.test(reports[1]), 'open tabs\' release reports (POST /release-metrics) reach the app');
assert.ok(conf.indexOf('location = /release-metrics') < conf.lastIndexOf('    location / {'), 'before the GET-only catch-all');
console.log('vhost catch-all: GET/HEAD reach the app (favicon, 404 page); other methods refused; /metrics refused; POST /release-metrics passes');
