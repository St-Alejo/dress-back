# SeaweedFS como S3 con las fotos del catálogo ya cargadas (demo en Azure: arranca sin volumen).
# Los datos van en /seed y no en /data porque la imagen base declara /data como VOLUME.
FROM chrislusf/seaweedfs:4.48
COPY storage-start.sh /usr/local/bin/storage-start.sh
RUN chmod +x /usr/local/bin/storage-start.sh
COPY build/s3data /seed
ENTRYPOINT ["/usr/local/bin/storage-start.sh"]
