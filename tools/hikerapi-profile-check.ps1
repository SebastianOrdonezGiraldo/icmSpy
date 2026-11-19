#requires -Version 5.1
<#
One local profile diagnostic. No credentials or response bodies are written to disk.
The provider has no documented server-side dollar cap. The rate must be confirmed
in the account before running; unknown rates cancel the request.
Sources checked 2026-11-17:
https://hiker-doc.readthedocs.io/en/latest/api-reference/v1/user/
https://hiker-doc.readthedocs.io/en/latest/guides/request-costs/
https://hiker-doc.readthedocs.io/en/latest/guides/rate-limits/
#>

function New-HikerProfileClient {
    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $handler.UseDefaultCredentials = $false
    $client = [System.Net.Http.HttpClient]::new($handler, $true)
    $client.Timeout = [TimeSpan]::FromSeconds(45)
    return $client
}

function Invoke-HikerProfileCheck {
    $secret = $null
    $plainKey = $null
    $keyBuffer = [IntPtr]::Zero
    $client = $null
    $request = $null
    $response = $null
    $profile = $null
    $raw = $null
    $result = [ordered]@{
        objetivo = '@tiendafisioco'
        endpoint = 'GET /v1/user/by/username?username=tiendafisioco'
        fechaUTC = [DateTime]::UtcNow.ToString('o')
        solicitudesIniciadas = 0
        reintentos = 0
        presupuestoUSD = [decimal]0.02
        topeMonetarioRemotoDisponible = $false
        tarifaConfirmadaUSD = $null
        estadoHTTP = $null
        unidadesReportadas = $null
        costoCalculadoUSD = $null
        resultado = 'CANCELADO'
        campos = @()
    }

    try {
        Write-Host 'Una consulta del perfil; no se consultaran seguidores.'
        Write-Host 'HikerAPI no ofrece un tope monetario remoto documentado.'
        Write-Host 'Introduce la tarifa REAL de tu cuenta. No la deduzcas del saldo.'
        $rateText = Read-Host 'USD por unidad (ej. 0.02; Enter si no conoces la tarifa)'
        $unitPrice = [decimal]0
        $validRate = [decimal]::TryParse(
            ([string]$rateText).Trim().Replace(',', '.'),
            [Globalization.NumberStyles]::AllowDecimalPoint,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$unitPrice
        )
        if (-not $validRate -or $unitPrice -lt 0 -or $unitPrice -gt [decimal]0.02) {
            $result.resultado = 'CANCELADO_TARIFA_DESCONOCIDA_O_SUPERIOR_A_0_02_USD'
            return [pscustomobject]$result
        }
        $result.tarifaConfirmadaUSD = $unitPrice

        $secret = Read-Host 'API Key de HikerAPI (oculta, solo en memoria)' -AsSecureString
        if ($null -eq $secret -or $secret.Length -eq 0) {
            $result.resultado = 'CANCELADO_CLAVE_VACIA'
            return [pscustomobject]$result
        }

        $client = New-HikerProfileClient
        $request = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Get,
            'https://api.hikerapi.com/v1/user/by/username?username=tiendafisioco'
        )
        $request.Version = [Version]::new(1, 1)
        $request.Headers.ConnectionClose = $true
        $request.Headers.Accept.ParseAdd('application/json')

        $keyBuffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyBuffer)
        if ([string]::IsNullOrWhiteSpace($plainKey) -or $plainKey -match '[\r\n]') {
            $result.resultado = 'CANCELADO_CLAVE_INVALIDA'
            return [pscustomobject]$result
        }
        $request.Headers.Add('x-access-key', $plainKey)
        $plainKey = $null
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyBuffer)
        $keyBuffer = [IntPtr]::Zero
        $secret.Dispose()
        $secret = $null

        # The only application request. Never retry, including after a timeout.
        $result.solicitudesIniciadas = 1
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $result.estadoHTTP = [int]$response.StatusCode

        if ($response.Headers.Contains('x-hiker-info')) {
            try {
                $billingText = $response.Headers.GetValues('x-hiker-info') -join ''
                $billing = $billingText | ConvertFrom-Json -ErrorAction Stop
                $units = [decimal]0
                if ([decimal]::TryParse(
                    [string]$billing.reqs,
                    [Globalization.NumberStyles]::Integer,
                    [Globalization.CultureInfo]::InvariantCulture,
                    [ref]$units
                ) -and $units -ge 0) {
                    $result.unidadesReportadas = $units
                    $result.costoCalculadoUSD = $unitPrice * $units
                }
            } catch {
                # Do not display untrusted headers or exception contents.
            }
        }

        if (-not $response.IsSuccessStatusCode) {
            $result.resultado = 'HTTP_NO_EXITOSO_SIN_REINTENTOS_CUERPO_OCULTO'
            return [pscustomobject]$result
        }

        $raw = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $profile = $raw | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $profile -or $profile -is [array] -or
            $null -eq $profile.PSObject.Properties['username'] -or
            $profile.username -ne 'tiendafisioco') {
            $result.resultado = 'RESPUESTA_NO_RECONOCIDA_CUERPO_OCULTO'
            return [pscustomobject]$result
        }
        if ($profile.PSObject.Properties['is_private'] -and $profile.is_private -eq $true) {
            $result.resultado = 'PERFIL_PRIVADO_NO_PROCESADO'
            return [pscustomobject]$result
        }

        # Only schema field names, types and presence are exposed; never values.
        $knownFields = @(
            'pk', 'username', 'full_name', 'is_private', 'is_verified',
            'profile_pic_url', 'profile_pic_url_hd', 'media_count',
            'follower_count', 'following_count', 'biography', 'external_url',
            'account_type', 'is_business', 'public_email',
            'contact_phone_number', 'public_phone_country_code',
            'public_phone_number', 'business_contact_method',
            'business_category_name', 'category_name', 'category',
            'address_street', 'city_id', 'city_name', 'latitude', 'longitude',
            'zip', 'instagram_location_id', 'interop_messaging_user_fbid'
        )
        $result.campos = @(foreach ($name in $knownFields) {
            $property = $profile.PSObject.Properties[$name]
            $state = 'ausente'
            $type = $null
            if ($null -ne $property) {
                if ($null -eq $property.Value) {
                    $state = 'nulo'
                } else {
                    $type = $property.Value.GetType().Name
                    if ($property.Value -is [string] -and
                        [string]::IsNullOrWhiteSpace($property.Value)) {
                        $state = 'vacio'
                    } else {
                        $state = 'con_valor_oculto'
                    }
                }
            }
            [pscustomobject]@{ campo = $name; tipo = $type; estado = $state }
        })
        $result.resultado = 'OK_VALORES_OCULTOS'
        if ($null -ne $result.costoCalculadoUSD -and
            $result.costoCalculadoUSD -gt [decimal]0.02) {
            $result.resultado = 'PROVEEDOR_REPORTO_MAS_UNIDADES_DE_LAS_DOCUMENTADAS'
        }
        return [pscustomobject]$result
    } catch {
        if ($result.solicitudesIniciadas -eq 1) {
            $result.resultado = 'FALLO_TRAS_INICIAR_SOLICITUD_SIN_REINTENTO_COBRO_POR_CONFIRMAR'
        } else {
            $result.resultado = 'CANCELADO_ANTES_DE_ENVIAR_SOLICITUD'
        }
        # Exception text and response bodies can contain secrets or personal data.
        return [pscustomobject]$result
    } finally {
        if ($keyBuffer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyBuffer)
        }
        if ($null -ne $secret) { $secret.Dispose() }
        if ($null -ne $request) {
            $request.Headers.Remove('x-access-key') | Out-Null
            $request.Dispose()
        }
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
        $plainKey = $null
        $profile = $null
        $raw = $null
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-HikerProfileCheck | ConvertTo-Json -Depth 5
}
