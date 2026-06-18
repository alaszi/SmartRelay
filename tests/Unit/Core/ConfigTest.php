<?php

declare(strict_types=1);

namespace SmartRelay\Tests\Unit\Core;

use PHPUnit\Framework\TestCase;
use SmartRelay\Core\Config;

class ConfigTest extends TestCase
{
    protected function setUp(): void
    {
        Config::reset();
    }

    protected function tearDown(): void
    {
        Config::reset();
    }

    public function testGetReturnsDefaultWhenKeyMissing(): void
    {
        $result = Config::get('NON_EXISTENT_KEY', 'default_value');
        $this->assertSame('default_value', $result);
    }

    public function testGetReturnsNullDefaultWhenNotSpecified(): void
    {
        $result = Config::get('NON_EXISTENT_KEY');
        $this->assertNull($result);
    }

    public function testHasReturnsFalseForMissingKey(): void
    {
        $this->assertFalse(Config::has('NON_EXISTENT_KEY'));
    }

    public function testGetReadsFromEnvironment(): void
    {
        putenv('SMARTRELAY_TEST_VAR=hello');
        $result = Config::get('SMARTRELAY_TEST_VAR');
        $this->assertSame('hello', $result);
        putenv('SMARTRELAY_TEST_VAR');
    }

    public function testHasReturnsTrueForSetEnvironmentVar(): void
    {
        putenv('SMARTRELAY_TEST_HAS=1');
        $this->assertTrue(Config::has('SMARTRELAY_TEST_HAS'));
        putenv('SMARTRELAY_TEST_HAS');
    }
}
