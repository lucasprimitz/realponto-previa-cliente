<?php
declare(strict_types=1);
// Copiar para uma pasta privada fora da publicação. Não colocar segredos no Git.
// Definir CONTACTS_CONFIG_FILE com o caminho absoluto deste arquivo no PHP/FPM e no cron.
return [
    'origin' => 'https://ENDERECO-A-DEFINIR',
    'cookiePath' => '/',
    'dataDirectory' => '/var/lib/realponto-contatos',
    'encryptionKey' => '', // Base64 de 32 bytes aleatórios; manter estável e guardar backup seguro.
    'passwordHash' => '', // Resultado de password_hash; nunca a senha em texto simples.
    'submissionsEnabled' => false, // Ativar somente após o teste completo da TI.
    'developmentLoopback' => false, // Apenas teste local, nunca habilitar para endereço de rede.
    'mail' => [
        'enabled' => false,
        'host' => '',
        'port' => 587,
        'encryption' => 'tls', // tls (STARTTLS) ou ssl (TLS implícito).
        'authentication' => true,
        'username' => '',
        'password' => '',
        'from' => '',
        'recipient' => '', // A TI pode definir/alterar o e-mail aqui depois.
    ],
];
