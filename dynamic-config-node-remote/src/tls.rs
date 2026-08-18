//! The TLS options object, shared by every store that dials TLS.

use super::*;

/// TLS material, as a caller hands it over.
///
/// Files *and* bytes, because both are real: a Kubernetes secret is a
/// mounted file, and a certificate fetched from a vault at startup is
/// bytes that never touch a disk. The store crates take either, and this
/// is the same choice one argument list further out.
#[napi(object)]
#[derive(Default)]
pub struct Tls {
    /// A private certificate authority, as a path.
    pub ca_certificate_file: Option<String>,
    /// The same, as PEM bytes.
    pub ca_certificate_pem: Option<String>,
    /// A client certificate and its key, as paths.
    pub client_certificate_file: Option<String>,
    /// The key that goes with it.
    pub client_key_file: Option<String>,
    /// The same pair, as PEM bytes.
    pub client_certificate_pem: Option<String>,
    /// The key that goes with it.
    pub client_key_pem: Option<String>,
}

impl Tls {
    /// The store crates' own configuration, or `None` when nothing was
    /// said — which means *the platform's trust store*, not *no TLS*.
    ///
    /// Half a client identity is refused rather than ignored: a
    /// deployment that meant mTLS and typed one of the two field names
    /// would otherwise connect with no certificate at all and be told by
    /// the server that its *permissions* are wrong.
    pub(crate) fn resolved(&self) -> Result<Option<TlsConfig>, Error> {
        for (certificate, key, kind) in [
            (
                self.client_certificate_file.is_some(),
                self.client_key_file.is_some(),
                "clientCertificateFile/clientKeyFile",
            ),
            (
                self.client_certificate_pem.is_some(),
                self.client_key_pem.is_some(),
                "clientCertificatePem/clientKeyPem",
            ),
        ] {
            if certificate != key {
                return Err(Error::auth(format!(
                    "a client certificate needs both halves: `{kind}` were \
                     given one at a time, and a store that connected \
                     without an identity would be refused by the server as \
                     a permissions problem instead"
                )));
            }
        }

        let mut config = TlsConfig::new();
        let mut said = false;

        if let Some(path) = &self.ca_certificate_file {
            config = config.with_ca_certificate_file(path.clone());
            said = true;
        }
        if let Some(pem) = &self.ca_certificate_pem {
            config = config.with_ca_certificate_pem(pem.clone().into_bytes());
            said = true;
        }
        if let (Some(certificate), Some(key)) =
            (&self.client_certificate_file, &self.client_key_file)
        {
            config = config.with_client_certificate_files(certificate.clone(), key.clone());
            said = true;
        }
        if let (Some(certificate), Some(key)) = (&self.client_certificate_pem, &self.client_key_pem)
        {
            config = config.with_client_certificate_pem(
                certificate.clone().into_bytes(),
                key.clone().into_bytes(),
            );
            said = true;
        }

        Ok(said.then_some(config))
    }
}
