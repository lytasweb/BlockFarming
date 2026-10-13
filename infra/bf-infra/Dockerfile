FROM alpine:3.18

RUN apk add --no-cache postgresql15 postgresql15-client redis bash su-exec

COPY start.sh /start.sh
RUN chmod +x /start.sh

COPY init.sql /init.sql

EXPOSE 5432 6379

CMD ["/start.sh"]
