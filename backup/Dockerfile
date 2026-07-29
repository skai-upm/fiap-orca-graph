FROM python:3.12-alpine

WORKDIR /app
COPY backup.py .

RUN mkdir -p /backups

CMD ["python", "-u", "backup.py"]
