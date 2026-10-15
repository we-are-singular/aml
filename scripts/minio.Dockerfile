FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS build

WORKDIR /src
# MinIO removed its community images. Build the last upstream source revision
# with a current Go toolchain while preserving the local S3 test fixture.
ADD --checksum=sha256:71794c2df26aad0cc99e8421c58b7aa2dd55969f979b0e7d1e931042e9fabcd6 https://codeload.github.com/minio/minio/tar.gz/7aac2a2c5b7c882e68c1ce017d8256be2feea27f /tmp/minio.tar.gz
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1 \
    && CGO_ENABLED=0 go build -trimpath -o /out/minio .

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
    org.opencontainers.image.revision="7aac2a2c5b7c882e68c1ce017d8256be2feea27f"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /usr/share/doc/minio/LICENSE

EXPOSE 9000 9001
ENTRYPOINT ["minio"]
