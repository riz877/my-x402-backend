// --- KODE JAVASCRIPT DI SISI BROWSER (KLIEN) ---

// Ganti dengan URL Netlify Function Anda yang sebenarnya
const NETLIFY_MINT_URL = 'https://mint.x402hood.xyz/.netlify/functions/mint'; 

/**
 * Fungsi aman untuk memanggil endpoint minting. Membaca body hanya sekali (response.json()).
 * @param {object} payload - Payload otorisasi pembayaran (null untuk permintaan GET)
 */
async function callMintEndpointReadOnce(payload = null) {
    const method = payload ? 'POST' : 'GET';
    
    const fetchOptions = {
        method: method,
        headers: {
            'Content-Type': 'application/json',
        },
        body: payload ? JSON.stringify(payload) : undefined,
    };

    try {
        const response = await fetch(NETLIFY_MINT_URL, fetchOptions);

        // *** Langkah Kunci: Baca body HANYA SEKALI, simpan hasilnya ***
        let responseData;
        try {
            // Coba baca sebagai JSON (untuk 200 OK dan 402 Payment Required)
            responseData = await response.json(); 
        } catch (e) {
            // Jika parsing JSON gagal (misalnya, server 500 mengirim teks mentah), 
            // baca sebagai teks
            responseData = await response.text(); 
            // Catatan: Jika response.ok (misal 200) tapi bukan JSON, 
            // ini mungkin menunjukkan masalah format data.
        }
        // -------------------------------------------------------------

        // 1. Tangani Status Gagal atau 402
        if (!response.ok) {
            
            // Gunakan data yang sudah dibaca (responseData) untuk semua kasus
            if (response.status === 402) {
                // Status 402 (Permintaan Pembayaran)
                console.log("Menerima detail pembayaran 402:", responseData);
                return { status: 'PAYMENT_REQUIRED', data: responseData };
            }
            
            // Status Error Lain (400, 500)
            console.error(`❌ Server Error ${response.status}:`, responseData);
            
            // Mengasumsikan responseData adalah string error atau objek error
            const errorMessage = typeof responseData === 'object' && responseData.error 
                                ? responseData.error 
                                : String(responseData);

            throw new Error(`Transaksi gagal. Server merespon dengan ${response.status}: ${errorMessage.substring(0, 100)}...`);
        }

        // 2. Respons Sukses (200 OK)
        // responseData sekarang berisi objek sukses dari server Netlify
        const successData = responseData; 
        
        console.log("✅ Mint Sukses:", successData);
        return { status: 'SUCCESS', data: successData };

    } catch (error) {
        console.error("Kesalahan Fetch, Parsing, atau Network:", error);
        throw error;
    }
}