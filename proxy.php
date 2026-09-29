<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode([
        'status' => false,
        'error' => 'Method Not Allowed'
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);

if (!is_array($body)) {
    http_response_code(400);
    echo json_encode([
        'status' => false,
        'error' => 'JSON غير صالح'
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$text = trim((string)($body['text'] ?? ''));

if ($text === '') {
    http_response_code(400);
    echo json_encode([
        'status' => false,
        'error' => 'يرجى كتابة رسالة أولاً'
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if (mb_strlen($text) > 12000) {
    http_response_code(400);
    echo json_encode([
        'status' => false,
        'error' => 'النص طويل جدًا لهذه النسخة التجريبية'
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$temperature = isset($body['temperature']) ? (float)$body['temperature'] : 0.7;
$temperature = max(0, min(2, $temperature));

$accessKey = trim((string)($body['key'] ?? ''));

$params = [
    'text' => $text,
    'temperature' => $temperature
];

if ($accessKey !== '') {
    $params['key'] = $accessKey;
}

$conversationId = trim((string)($body['conversation_id'] ?? $body['chat_id'] ?? ''));

if ($conversationId !== '') {
    $params['conversation_id'] = $conversationId;
}

if (!empty($body['link'])) {
    $params['link'] = (string)$body['link'];
}

$upstream = 'https://camillecyrm.serv00.net/GPT-5-6/api?' . http_build_query($params);

$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL => $upstream,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT => 55,
    CURLOPT_HTTPHEADER => [
        'Accept: application/json, text/plain;q=0.9, */*;q=0.8',
        'User-Agent: Ashur-AI-Test/1.0'
    ]
]);

$raw = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($raw === false || $raw === '') {
    http_response_code(502);
    echo json_encode([
        'status' => false,
        'error' => 'تعذر الاتصال بالخدمة الخارجية',
        'details' => $curlError
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$data = json_decode($raw, true);

if (!is_array($data)) {
    http_response_code(502);
    echo json_encode([
        'status' => false,
        'error' => 'الخدمة الخارجية لم ترجع JSON صالح',
        'upstream_status' => $httpCode,
        'preview' => mb_substr($raw, 0, 700)
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$answer = $data['response'] ?? $data['answer'] ?? $data['message'] ?? $data['result'] ?? null;

if ($httpCode >= 400 || !$answer) {
    http_response_code(502);
    echo json_encode([
        'status' => false,
        'error' => $data['error'] ?? ('الخدمة الخارجية أعادت HTTP ' . $httpCode),
        'upstream_status' => $httpCode
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

echo json_encode([
    'status' => true,
    'response' => (string)$answer,
    'model' => $data['model'] ?? 'GPT-5.6',
    'conversation_id' => $data['conversation_id'] ?? $data['chat_id'] ?? ($conversationId ?: null)
], JSON_UNESCAPED_UNICODE);
