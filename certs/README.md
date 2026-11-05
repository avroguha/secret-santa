# Site certificate authorities

Drop your site's root/intermediate CA certificates here as `*.crt` files in PEM form
(one certificate per file, name ending in `.crt`). They are trusted by the image build
(npm) and installed into the image's system store, which the app uses.

Needed only when:

* the internal npm registry presents a certificate issued by an internal CA, or
* the outbound proxy inspects TLS - otherwise Microsoft sign-in fails with a certificate
  error.

Leave this folder empty otherwise. CA certificates are public; private keys never go here.
`*.crt` files are gitignored.
