# The per-job egress proxy: tinyproxy on alpine. The job container has no route out (an --internal network);
# this sidecar is its only door, CONNECT to 443/80, with a deny list for everything on the owner's LAN.
FROM alpine:3.20
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY deny.txt /etc/tinyproxy/deny.txt
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
