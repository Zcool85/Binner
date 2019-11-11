﻿using Binner.Common;
using Binner.Common.StorageProviders;
using LightInject;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Diagnostics;
using System.IO;

namespace Binner.Web.Configuration
{
    public partial class StartupConfiguration
    {
        const string ConfigFile = "appsettings.json";

        public static IConfigurationRoot Configure(IServiceContainer container, IServiceCollection services)
        {
            //var configPath = AppDomain.CurrentDomain.BaseDirectory;
            //var configPath = Environment.CurrentDirectory;
            var configPath = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
            var configFile = Path.Combine(configPath, ConfigFile);
            Console.WriteLine($".Net Core bundle path: {AppContext.BaseDirectory}");
            Console.WriteLine($"Config file location: {configFile}");
            var configuration = Config.GetConfiguration(configFile);
            var serviceConfiguration = configuration.GetSection(nameof(WebHostServiceConfiguration)).Get<WebHostServiceConfiguration>();
            var storageProviderConfiguration = configuration.GetSection(nameof(StorageProviderConfiguration)).Get<StorageProviderConfiguration>();
            var binnerConfig = new BinnerFileStorageConfiguration(storageProviderConfiguration.ProviderConfiguration);

            // support IOptions<> MS dependency injection
            services.Configure<WebHostServiceConfiguration>(options => configuration.GetSection(nameof(WebHostServiceConfiguration)).Bind(options));

            // register traditional configuration with LightInject
            services.AddSingleton(serviceConfiguration);
            container.RegisterInstance(serviceConfiguration);
            services.AddSingleton(storageProviderConfiguration);
            container.RegisterInstance(storageProviderConfiguration);
            services.AddSingleton(binnerConfig);
            container.RegisterInstance(binnerConfig);

            return configuration;
        }
    }
}
