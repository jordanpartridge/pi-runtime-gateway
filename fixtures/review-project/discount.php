<?php

// Deliberately incorrect arithmetic for the runtime's read-only review proof.
function discountedTotal(float $subtotal, float $percent): float
{
    return $subtotal - $percent;
}
